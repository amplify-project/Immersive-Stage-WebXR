/* << Copyright 2022 Iñigo Tamayo Uria, Ana Domínguez Fanlo, Mikel Joseba Zorrilla Berasategui, Héctor Rivas Pagador, Sergio Cabrero Barros, Juan Felipe Mogollón Rodríguez and Stefano Masneri. >>
This file is part of Orkestralib.
Orkestralib is free software: you can redistribute it and/or modify it under the terms of the GNU Lesser General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
Orkestralib is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Lesser General Public License for more details.
You should have received a copy of the GNU Lesser General Public License along with Orkestralib. If not, see <https://www.gnu.org/licenses/>. */
/**
 * @file A synchronized clock converts a local timestamp into the corresponding
 * value of a reference clock it is synchronized with.
 *
 * This is an abstract base class that returns a dummy clock synchronized with
 * itself (but note readyState remains at "connecting", hence the class should
 * not be used directly)
 */
  import { EventTarget } from './event-target.js';

  /**
   * Default constructor for a synchronized clock
   *
   * @class
   * @param {Number} initialSkew The initial clock skew
   * @param {Number} initialDelta The initial static delta
   */
  /** @type Class */
  var AbstractSyncClock = function (initialSkew, initialDelta) {
    var self = this;

    /**
     * The current estimation of the skew with the reference clock, in ms
     */
    var skew = initialSkew || 0.0;

    /**
     * Some agreed fixed delta delay, in ms.
     */
    var delta = initialDelta || 0.0;

    /**
     * The ready state of the synchronized clock
     */
    var readyState = 'connecting';

    /**
     * Define the "readyState", "skew" and "delta" properties. Note that
     * setting these properties may trigger "readystatechange" and "change"
     * events.
     */
    Object.defineProperties(this, {
      readyState: {
        get: function () {
          return readyState;
        },
        set: function (state) {
          if (state !== readyState) {
            readyState = state;
  
            // Dispatch the event on next loop to give code that wants to
            // listen to the initial change to "open" time to attach an event
            // listener (locally synchronized clocks typically set the
            // readyState property to "open" directly within the constructor)
            setTimeout(function () {
              self.dispatchEvent({
                type: 'readystatechange',
                value: state
              });
            }, 0);
          }
        }
      },
      delta: {
        get: function () {
          return delta;
        },
        set: function (value) {
          var previousDelta = delta;
          delta = value;
          if (previousDelta === delta) {
          } else {
            self.dispatchEvent({
              type: 'change'
            });
          }
        }
      },
      skew: {
        get: function () {
          return skew;
        },
        set: function (value) {
          var previousSkew = skew;
          skew = value;
          if (readyState !== 'open') {
          } else if (previousSkew === skew) {
          } else {
            self.dispatchEvent({
              type: 'change'
            });
          }
        }
      }
    });
  };

  // Synchronized clocks implement EventTarget
  AbstractSyncClock.prototype.addEventListener = EventTarget().addEventListener;
  AbstractSyncClock.prototype.removeEventListener = EventTarget().removeEventListener;
  AbstractSyncClock.prototype.dispatchEvent = EventTarget().dispatchEvent;

  /**
   * Returns the time at the reference clock that corresponds to the local
   * time provided (both in milliseconds since 1 January 1970 00:00:00 UTC)
   *
   * @function
   * @param {Number} localTime The local time in milliseconds
   * @returns {Number} The corresponding time on the reference clock
   */
  AbstractSyncClock.prototype.getTime = function (localTime) {
    return localTime + this.skew - this.delta;
  };

  /**
   * Returns the number of milliseconds elapsed since
   * 1 January 1970 00:00:00 UTC on the reference clock
   *
   * @function
   * @returns {Number} The current timestamp
   */
  AbstractSyncClock.prototype.now = function () {
    return this.getTime(Date.now());
  };

  /**
   * Stops synchronization with the reference clock.
   *
   * In derived classes, this should typically be used to stop background
   * synchronization mechanisms.
   *
   * @function
   */
  AbstractSyncClock.prototype.close = function () {
    if ((this.readyState === 'closing') ||
        (this.readyState === 'closed')) {
      return;
    }
    this.readyState = 'closing';
    this.readyState = 'closed';
  };

export {AbstractSyncClock};
