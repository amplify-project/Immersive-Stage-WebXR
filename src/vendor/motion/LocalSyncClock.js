/* << Copyright 2022 Iñigo Tamayo Uria, Ana Domínguez Fanlo, Mikel Joseba Zorrilla Berasategui, Héctor Rivas Pagador, Sergio Cabrero Barros, Juan Felipe Mogollón Rodríguez and Stefano Masneri. >>
This file is part of Orkestralib.
Orkestralib is free software: you can redistribute it and/or modify it under the terms of the GNU Lesser General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
Orkestralib is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Lesser General Public License for more details.
You should have received a copy of the GNU Lesser General Public License along with Orkestralib. If not, see <https://www.gnu.org/licenses/>. */
/**
 * @file A clock synchronized with itself.
 *
 * This class should only really be used for testing.
 */

import { AbstractSyncClock } from './AbstractSyncClock.js';

/**
 * Default constructor for a synchronized clock
 *
 * @class
 */
/** @type Class */
var LocalSyncClock = function (initialSkew, initialDelta) {
  // Initialize the base class with default data
  AbstractSyncClock.call(this);
  this.readyState = 'open';
};
LocalSyncClock.prototype = new AbstractSyncClock();

// Expose the class to the outer world
export { LocalSyncClock };
