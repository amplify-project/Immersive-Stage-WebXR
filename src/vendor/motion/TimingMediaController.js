/* << Copyright 2022 Iñigo Tamayo Uria, Ana Domínguez Fanlo, Mikel Joseba Zorrilla Berasategui, Héctor Rivas Pagador, Sergio Cabrero Barros, Juan Felipe Mogollón Rodríguez and Stefano Masneri. >>
This file is part of Orkestralib.
Orkestralib is free software: you can redistribute it and/or modify it under the terms of the GNU Lesser General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
Orkestralib is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Lesser General Public License for more details.
You should have received a copy of the GNU Lesser General Public License along with Orkestralib. If not, see <https://www.gnu.org/licenses/>. */
/**
 * @file A timing media controller takes inputs from a timing object and
 * harnesses one or more HTML media elements (audio, video, media controller)
 * accordingly.
 *
 * A timing media controller exposes usual media element controls such as
 * "play", "pause" methods as well as "currentTime" and "playbackRate"
 * attributes. Internally, calling these methods or setting these attributes
 * update the timing object's state vector, which should in turn affect the
 * HTML media elements that the timing media controller harnesses.
 *
 * Said differently, commands sent to a timing media controller are not
 * directly applied to the HTML media elements under control. Everything goes
 * through the timing object to enable cross-device synchronization effects.
 *
 * TODO: add logic to handle buffering hiccups in media elements.
 * TODO: add logic to remove elements from the list of controlled elements.
 */

import { EventTarget } from './event-target.js';
import { TimingObject } from './TimingObject.js';
import { StateVector } from './StateVector.js';

/**
 * Constructor of a timing media controller
 *
 * @class
 * @param {TimingObject} timing The timing object attached to the controller
 * @param {Object} options controller settings
 */
/** @type Class */
var TimingMediaController = function (timing, options) {
  // eslint-disable-next-line @typescript-eslint/no-this-alias
  var self = this;
  options = options || {};

  if (!timing || !(timing instanceof TimingObject)) {
    throw new Error('No timing object provided');
  }

  /**
   * The timing media controller's internal settings
   */
  var settings = {
    // Media elements are considered in sync with the timing object if the
    // difference between the position they report and the position of the
    // timing object is below that threshold (in seconds).
    minDiff: options.minDiff || 0.04, // 0.010

    // Maximum delay for catching up (in seconds).
    // If the code cannot meet the maxDelay constraint,
    // it will have the media element directly seek to the right position.
    maxDelay: options.maxDelay || 0.8, // 1.0

    // Amortization period (in seconds).
    // The amortization period is used when adjustments are made to
    // the playback rate of the video.
    amortPeriod: options.amortPeriod || 1.0, // 2.0

    // How long the controller stays blind after a seek (in seconds).
    //
    // A seek flushes the buffer and fetches a fresh segment, and until that
    // lands the element's position says nothing useful — hence a pause before
    // judging it again. This used to be derived from amortPeriod (x2), which
    // made one knob do two opposite jobs: asking for a *smoother* correction
    // bought a *longer* spell of no correction at all. Measured with
    // amortPeriod 8, a client that joined late sat 0.95 s behind for sixteen
    // seconds, corrected half of it, and sat there another sixteen.
    blindPeriod: options.blindPeriod || (options.amortPeriod || 1.0) * 2,

    // Largest playback-rate deviation the controller may ask for.
    //
    // The correction is proportional — 1 + diff/amortPeriod — so the rate it
    // asks for grows with the error and is bounded only by maxDelay/amortPeriod.
    // At 0.8/8 that is 10%, about 1.6 semitones: fine for speech, not for
    // music, and it arrives exactly when a late joiner is listening. Capping
    // it trades a longer catch-up for an inaudible one.
    maxRateDev: options.maxRateDev || 1.0,

    // Initial guess at what a seek costs (in seconds), refined by measurement.
    // See seekLead below.
    seekLead: options.seekLead || 0.0
  };

  /**
   * The list of Media elements controlled by this timing media controller.
   *
   * For each media element, the controller maintains a state vector
   * representation of the element's position and velocity, a drift rate
   * to adjust the playback rate, whether we asked the media element to
   * seek or not, and whether there is an amortization period running for
   * the element
   *
   * {
   *   vector: {},
   *   driftRate: 0.0,
   *   seeked: false,
   *   amortization: false,
   *   element: {}
   * }
   */
  var controlledElements = [];

  /**
   * The timing object's state vector last time we checked it.
   * This variable is used in particular at the end of the amortization
   * period to compute the media element's drift rate
   */
  var timingVector = null;

  /**
   * Pointer to the amortization period timeout.
   * The controller uses only one amortization period for all media elements
   * under control.
   */
  var amortTimeout = null;

  Object.defineProperties(this, {
    /**
     * Report the state of the underlying timing object
     *
     * TODO: should that also take into account the state of the controlled
     * elements? Hard to find a proper definition though
     */
    readyState: {
      get: function () {
        // eslint-disable-next-line no-undef
        return timingProvider.readyState;
      }
    },

    /**
     * The currentTime attribute returns the position that all controlled
     * media elements should be at, in other words the position of the
     * timing media controller when this method is called.
     *
     * On setting, the timing object's state vector is updated with the
     * provided value, which will (asynchronously) affect all controlled
     * media elements.
     *
     * Note that getting "currentTime" right after setting it may not return
     * the value that was just set.
     */
    currentTime: {
      get: function () {
        return timing.currentPosition;
      },
      set: function (value) {
        console.log('TimingMediaController - currentTime set: '+value);
        timing.update(value, null);
      }
    },

    /**
     * The current playback rate of the controller (controlled media elements
     * may have a slightly different playback rate since the role of the
     * controller is precisely to adjust their playback rate to ensure they
     * keep up with the controller's position.
     *
     * On setting, the timing object's state vector is updated with the
     * provided value, which will (asynchronously) affect all controlled
     * media elements.
     *
     * Note that getting "playbackRate" right after setting it may not return
     * the value that was just set.
     */
    playbackRate: {
      get: function () {
        return timing.currentVelocity;
      },
      set: function (value) {
        console.log('playbackRate set');
        timing.update(null, value);
      }
    }
  });

  /**
   * Start playing the controlled elements
   *
   * @function
   */
  this.play = function () {
    console.log('this.play');
    timing.update(null, 1.0, null);
  };

  /**
   * Pause playback
   *
   * @function
   */
  this.pause = function () {
    console.log('timing.pause');
    timing.update(null, 0.0, null);
  };
  this.reset = function (vel) {
    console.log('timing.reset');
    timing.update(0.0, vel, null);
  };

  /**
   * Add a media element to the list of elements controlled by this
   * controller
   *
   * @function
   * @param {MediaElement} element The media element to associate with the
   *  controller.
   */
  this.addMediaElement = function (element, offset) {
    var found = false;
    if (element) {
      console.log('OFFSET', offset / 1000);
      element._offset = offset / 1000;
      controlledElements.forEach(function (wrappedEl) {
        console.log('Wrappeds: '+JSON.stringify(wrappedEl.element))
        if (wrappedEl.element === element) {   
          found = true;
        }
      });

      if (found) {
        controlledElements.forEach(function (wrappedEl) {
          console.log('FOUND Wrappeds: '+JSON.stringify(wrappedEl.element))
          if (wrappedEl.element === element) {   
            found = true;
          }
        });
        return;
      }
      
      var wrapped = {
        element: element,
        vector: null,
        driftRate: 0.0,
        seeked: false,
        amortization: false,
        // What a seek costs this element, in seconds: from setting currentTime
        // to playback advancing again. A seek to exactly the timing object's
        // position therefore always lands *late* by that much, and seeking
        // again cannot close a gap that every seek recreates. So we aim ahead
        // by the cost instead, and measure it as we go: the first seek pays
        // the guess, the ones after pay the measurement.
        seekLead: settings.seekLead,
        seekAt: 0,
        seekTo: 0
      };
      var onResume = function () {
        if (!wrapped.seekAt) {
          return;
        }
        // Only once playback has actually moved past where we put it.
        if (element.currentTime <= wrapped.seekTo) {
          return;
        }
        var cost = (Date.now() - wrapped.seekAt) / 1000;
        wrapped.seekAt = 0;
        if (cost > 0 && cost < 2.0) {
          wrapped.seekLead = (wrapped.seekLead * 0.5) + (cost * 0.5);
        }
      };
      element.addEventListener('playing', onResume);
      element.addEventListener('timeupdate', onResume);

      controlledElements.push(wrapped);
    }
  };
  /**
   * What the controller currently believes a seek costs this element, in
   * seconds — the figure it aims ahead by. Diagnostic only; it is the one
   * number that says whether the seek-lead measurement is converging.
   *
   * @function
   * @param {MediaElement} [element] defaults to the last element added
   * @returns {?number}
   */
  this.getSeekLead = function (element) {
    var lead = null;
    controlledElements.forEach(function (wrappedEl) {
      if (!element || wrappedEl.element === element) {
        lead = wrappedEl.seekLead;
      }
    });
    return lead;
  };

  this.removeMediaElement = function (element) {
    // var found = false;
    controlledElements = controlledElements.filter(function (wrappedEl) {
      if (wrappedEl.element === element) {
        return false;
      } else return true;
    });
  };

  /**
   * Helper function that cancels a running amortization period
   */
  var cancelAmortizationPeriod = function () {
    if (!amortTimeout) {
      return;
    }
    clearTimeout(amortTimeout);
    amortTimeout = null;
    controlledElements.forEach(function (wrappedEl) {
      wrappedEl.amortization = false;
      wrappedEl.seeked = false;
    });
  };

  /**
   * Helper function to stop the playback adjustment once the amortization
   * period is over.
   */
  var stopAmortizationPeriod = function () {
    // var now = Date.now() / 1000.0;
    amortTimeout = null;

    controlledElements.forEach(function (wrappedEl) {
      // Nothing to do if element was not part of amortization period
      if (!wrappedEl.amortization) {
        return;
      }
      wrappedEl.amortization = false;

      // Don't adjust playback rate and drift rate if video was seeked
      // or if element was not part of that amortization period.
      if (wrappedEl.seeked) {
        // end of amortization period for seek
        wrappedEl.seeked = false;
        return;
      }

      // Compute the difference between the position the video should be and
      // the position it is reported to be at.
      // var diff = wrappedEl.vector.computePosition(now) - wrappedEl.element.currentTime;

      // Compute the new video drift rate
      wrappedEl.driftRate = 0.002;

      // Switch back to the current vector's velocity,
      // adjusted with the newly computed drift rate
      wrappedEl.vector.velocity = timingVector.velocity + wrappedEl.driftRate;
      wrappedEl.element.playbackRate = wrappedEl.vector.velocity;
    });
  };

  /**
   * React to timing object's changes, harnessing the controlled
   * elements to align them with the timing object's position and velocity
   */
  var onTimingChange = function () {
    cancelAmortizationPeriod();
    controlElements();
  };

  /**
   * Ensure media elements are aligned with the current timing object's
   * state vector
   */
  /**
   * Is some element so far from the timing object that waiting is the wrong
   * answer? Deliberately blind to elements that are seeking or starved: there
   * the position means nothing yet, and seeking again would only buy another
   * buffer flush. This asks about elements that are playing, with data, and
   * simply in the wrong place.
   */
  var someElementLost = function () {
    var v;
    try {
      v = timing.query();
    } catch (e) {
      return false;
    }
    if (v.velocity === 0.0) {
      return false;
    }
    return controlledElements.some(function (wrappedEl) {
      var el = wrappedEl.element;
      if (el.seeking || el.paused || el.readyState <= el.HAVE_CURRENT_DATA) {
        return false;
      }
      return Math.abs(v.position - el.currentTime - el._offset) > settings.maxDelay;
    });
  };

  var controlElements = function () {
    // Do not adjust anything during an amortization period — unless an element
    // is plainly lost, which is the one case where not looking is indefensible.
    // A client joining an existing session is exactly that: it lands a second
    // behind, and every seek it makes re-arms this period, so it would wait out
    // one blind spell after another while the music played on without it.
    if (amortTimeout) {
      if (!someElementLost()) {
        return;
      }
      cancelAmortizationPeriod();
    }

    // Get new readings from Timing object
    timingVector = timing.query();

    controlledElements.forEach(controlElement);

    var amortNeeded = false;
    controlledElements.forEach(function (wrappedEl) {
      if (wrappedEl.amortization) {
        amortNeeded = true;
      }
    });

    if (amortNeeded) {
      // start amortization period
      amortTimeout = setTimeout(stopAmortizationPeriod, settings.blindPeriod * 1000);
    }

    // Queue a task to fire a simple event named "timeupdate"
    /*       setTimeout(function () {
        self.dispatchEvent({
          type: 'timeupdate'
        }, 0);
      }); */
  };

  /**
   * Ensure the given media element (wrapped in info structure) is aligned
   * with the current timing object's state vector
   */
  var controlElement = function (wrappedEl) {
    var { element } = wrappedEl;
    var diff = 0.0;
    var futurePos = 0.0;
    var isPlaying = element.currentTime > 0 && !element.paused && !element.ended && element.readyState > element.HAVE_CURRENT_DATA;

    // Reset the timer if its is trying to go beyond the max duration of the video while playing
    if ((element.duration && (timingVector.position > element.duration)) || timingVector.position < 0.0) {
      // console.log('Reseting client\'s timer -> trying to set the position beyond the max duration');
      timingVector.position = 0.0;
      element.currentTime = 0.0;
    }

    //  console.log("driftRate",wrappedEl.driftRate);
    if (timingVector.velocity === 0.0 && timingVector.acceleration === 0.0 && isPlaying) { // Wants to pause and its playing      
      element.pause();
      element.currentTime = wrappedEl.vector.position;
      wrappedEl.vector = new StateVector(timingVector);
    } else if (timingVector.velocity > 0.0 && !isPlaying) { // Wants to play and its paused
      // Update wrappedEl vector
      wrappedEl.vector = new StateVector({
        position: element.currentTime,
        velocity: timingVector.velocity + wrappedEl.driftRate,
        acceleration: 0.0,
        timestamp: timingVector.timestamp
      });
      wrappedEl.seeked = true;
      wrappedEl.amortization = true;
      // Update element
      element.currentTime = wrappedEl.vector.position - element._offset;
      element.playbackRate = wrappedEl.vector.velocity;
      element.play();
    } else { // Wants to pause and its playing
      // Update wrappedEl vector
      var vel = wrappedEl.vector ? wrappedEl.vector.velocity : 1;
      wrappedEl.vector = new StateVector({
        position: element.currentTime,
        velocity: vel
      });
      diff = timingVector.position - wrappedEl.vector.position - element._offset;
      //  console.log("diff",diff,"vel",wrappedEl.vector.velocity,"timing vel",timingVector.velocity,"offset",element._offset);
      if (Math.abs(diff) < settings.minDiff) {
        // video and vector are in sync!
      } else if (Math.abs(diff) > settings.maxDelay) {
        // Seek — but ahead of the timing object by what the seek itself will
        // cost, because the clock does not wait for our buffer. Landing on the
        // position we read is landing late by definition.
        wrappedEl.vector.position = timingVector.position + (wrappedEl.seekLead * timingVector.velocity);
        wrappedEl.vector.velocity = timingVector.velocity + wrappedEl.driftRate;
        wrappedEl.seeked = true;
        // Hold still while the buffer refills: until it does, this element's
        // position is not evidence of anything, and seeking on it again would
        // only pay for another flush.
        wrappedEl.amortization = true;
        element.currentTime = wrappedEl.vector.position - element._offset;
        element.playbackRate = wrappedEl.vector.velocity;
        wrappedEl.seekAt = Date.now();
        wrappedEl.seekTo = element.currentTime;
      } else {
        futurePos = timingVector.computePosition(timingVector.timestamp + settings.amortPeriod);
        var wanted =
          wrappedEl.driftRate + (futurePos - wrappedEl.vector.position) / settings.amortPeriod;
        // The correction is proportional to the error, so its size is not the
        // dead band divided by the amortization period — that is only its
        // smallest step. Left alone it reaches maxDelay/amortPeriod, which on a
        // sustained note is heard as pitch. maxRateDev is the ceiling; it
        // defaults wide enough to leave the original behaviour alone.
        var nominal = timingVector.velocity;
        wrappedEl.vector.velocity = Math.min(nominal + settings.maxRateDev,
                                    Math.max(nominal - settings.maxRateDev, wanted));
        wrappedEl.amortization = false;
        element.playbackRate = wrappedEl.vector.velocity < 0.25 ? 0 : wrappedEl.vector.velocity;
        // new playbackrate= wrappedEl.vector.velocity
        //  logger.info('new playbackrate={}', wrappedEl.vector.velocity);
      }
    }
  };

  /**********************************************************************
    Listen to the timing object
    **********************************************************************/

  timing.addEventListener('timeupdate', controlElements);
  timing.addEventListener('change', onTimingChange);

  timing.addEventListener('readystatechange', function (evt) {
    self.dispatchEvent(evt);
  });
};

// TimingMediaController implements EventTarget
TimingMediaController.prototype.addEventListener = EventTarget().addEventListener;
TimingMediaController.prototype.removeEventListener = EventTarget().removeEventListener;
TimingMediaController.prototype.dispatchEvent = EventTarget().dispatchEvent;

export { TimingMediaController };
