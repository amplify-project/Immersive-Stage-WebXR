/* << Copyright 2022 Iñigo Tamayo Uria, Ana Domínguez Fanlo, Mikel Joseba Zorrilla Berasategui, Héctor Rivas Pagador, Sergio Cabrero Barros, Juan Felipe Mogollón Rodríguez and Stefano Masneri. >>
This file is part of Orkestralib.
Orkestralib is free software: you can redistribute it and/or modify it under the terms of the GNU Lesser General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
Orkestralib is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Lesser General Public License for more details.
You should have received a copy of the GNU Lesser General Public License along with Orkestralib. If not, see <https://www.gnu.org/licenses/>. */
/**
 * @file A timing provider object associated with the local clock.
 *
 * Timing objects that are not associated with any other timing provider object
 * are automatically associated with an instance of that class.
 */

import {AbstractTimingProvider} from './AbstractTimingProvider.js';
import {StateVector} from './StateVector.js';
import { isNull } from './utils.js';

/**
 * Creates a timing provider
 *
 * @class
 */
/** @type Class */
var LocalTimingProvider = function (vector, range) {
  AbstractTimingProvider.call(this, vector, range);
  this.readyState = 'open';

};
LocalTimingProvider.prototype = new AbstractTimingProvider();

/**
 * Sends an update command to the online timing service.
 *
 * @function
 * @param {Object} vector The new motion vector
 * @param {Number} vector.position The new motion position.
 *   If null, the position at the current time is used.
 * @param {Number} vector.velocity The new velocity.
 *   If null, the velocity at the current time is used.
 * @param {Number} vector.acceleration The new acceleration.
 *   If null, the acceleration at the current time is used.
 * @returns {Promise} The promise to get an updated StateVector that
 *   represents the updated motion on the server once the update command
 *   has been processed by the server.
 *   The promise is rejected if the connection with the online timing service
 *   is not possible for some reason (no connection, timing object on the
 *   server was deleted, timeout, permission issue).
 */
LocalTimingProvider.prototype.update = function (vector) {
  vector = vector || {};

  var timestamp = Date.now() / 1000.0;
  var newVector = {
    position: isNull(vector.position) ? this.vector.computePosition(timestamp) : vector.position,
    velocity: isNull(vector.velocity) ? this.vector.computeVelocity(timestamp) : vector.velocity,
    acceleration: isNull(vector.acceleration) ? this.vector.computeAcceleration(timestamp) : vector.acceleration,
    timestamp: timestamp
  };
  this.vector = new StateVector(newVector);

  return new Promise(function (resolve, reject) {
    resolve(newVector);
  });
};

// Expose the class to the outer world
export { LocalTimingProvider };
