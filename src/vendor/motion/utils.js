/* << Copyright 2022 Iñigo Tamayo Uria, Ana Domínguez Fanlo, Mikel Joseba Zorrilla Berasategui, Héctor Rivas Pagador, Sergio Cabrero Barros, Juan Felipe Mogollón Rodríguez and Stefano Masneri. >>
This file is part of Orkestralib.
Orkestralib is free software: you can redistribute it and/or modify it under the terms of the GNU Lesser General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
Orkestralib is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Lesser General Public License for more details.
You should have received a copy of the GNU Lesser General Public License along with Orkestralib. If not, see <https://www.gnu.org/licenses/>. */
/**
 * @file A few useful utility functions
 */

export const toString = Object.prototype.toString

/**
 * Returns true when parameter is null
 *
 * @function
 * @param {*} obj Object to check
 * @returns {Boolean} true if object is null, false otherwise
 */
export const isNull = obj => {
  return obj === null
}

/**
 * Returns true when parameter is a number
 *
 * @function
 * @param {*} obj Object to check
 * @returns {Boolean} true if object is a number, false otherwise
 */
export const isNumber = obj => {
  return toString.call(obj) === '[object Number]'
}

/**
 * Serialize object as a JSON string
 *
 * @function
 * @param {Object} obj The object to serialize as JSON string
 * @return {String} The serialized JSON string
 */
export const stringify = obj => {
  return JSON.stringify(obj, null, 2)
}

export const getHostName = url => {
  const a = document.createElement('a')
  a.href = `http://${  url}`
  return a.hostname
}
