/* << Copyright 2022 Iñigo Tamayo Uria, Ana Domínguez Fanlo, Mikel Joseba Zorrilla Berasategui, Héctor Rivas Pagador, Sergio Cabrero Barros, Juan Felipe Mogollón Rodríguez and Stefano Masneri. >>
This file is part of Orkestralib.
Orkestralib is free software: you can redistribute it and/or modify it under the terms of the GNU Lesser General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
Orkestralib is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Lesser General Public License for more details.
You should have received a copy of the GNU Lesser General Public License along with Orkestralib. If not, see <https://www.gnu.org/licenses/>. */
/**
 * @file Defines an interval
 */

import { isNumber } from './utils.js';

/**
 * Creates an interval
 *
 * @class
 * @param {Object} range The range
 * @param {Number} range.low Lower bound of the interval
 * @param {Number} range.high Higher bound of the interval
 * @param {Boolean} range.lowInclude Whether to include the lower bound
 * @param {Boolean} range.highInclude Whether to include the higher bound
 */
/** @type Class */
var Interval = function (range) {
  range = range || {};

  this.low = range.low;
  this.lowInclude = range.lowInclude;
  this.high = range.high;
  this.highInclude = range.highInclude;

  // Ensure low <= high
  if (isNumber(this.low) && isNumber(this.high) && this.low > this.high) {
    range.low = this.high;
    range.lowInclude = this.highInclude;
    this.high = this.low;
    this.highInclude = this.lowInclude;
    this.low = range.low;
    this.lowInclude = range.lowInclude;
  }
};

/**
 * Returns true if interval covers the given value.
 *
 * @function
 * @param {Number} value Value to check
 * @returns {Boolean} true if interval covers the value
 */
Interval.prototype.covers = function (value) {
  return (
    (!this.low || this.low < value || (this.low === value && this.lowInclude)) &&
    (!this.high || this.high > value || (this.high === value && this.highInclude))
  );
};

/**
 * Returns true if low is equal to high
 *
 * @function
 * @returns true if low is equal to high
 */
Interval.prototype.isSingular = function () {
  return this.low === this.high;
};

// Expose the Interval class to the outer world
export { Interval };
