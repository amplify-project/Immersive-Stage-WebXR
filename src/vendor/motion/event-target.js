/* << Copyright 2022 Iñigo Tamayo Uria, Ana Domínguez Fanlo, Mikel Joseba Zorrilla Berasategui, Héctor Rivas Pagador, Sergio Cabrero Barros, Juan Felipe Mogollón Rodríguez and Stefano Masneri. >>
This file is part of Orkestralib.
Orkestralib is free software: you can redistribute it and/or modify it under the terms of the GNU Lesser General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
Orkestralib is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Lesser General Public License for more details.
You should have received a copy of the GNU Lesser General Public License along with Orkestralib. If not, see <https://www.gnu.org/licenses/>. */
/*! (C) WebReflection - Mit Style License */
var EventTarget=function(){"use strict";function o(e,t,i){n.value=i,r(e,t,n),n.value=null}function u(e,t,n){var r;s.call(e,t)?r=e[t]:o(e,t,r=[]),i.call(r,n)<0&&r.push(n)}function a(e,t,n){var r,i,o;if(s.call(e,t)){n.target=e,r=e[t].slice(0);for(o=0;o<r.length;o++)i=r[o],typeof i=="function"?i.call(e,n):typeof i.handleEvent=="function"&&i.handleEvent(n)}}function f(e,t,n){var r,o;s.call(e,t)&&(r=e[t],o=i.call(r,n),-1<o&&(r.splice(o,1),r.length||delete e[t]))}var e="@@",t={},n={configurable:!0,value:null},r=Object.defineProperty||function(t,n,r){t[n]=r.value},i=[].indexOf||function(t){var n=this.length;while(n--&&this[n]!==t);return n},s=t.hasOwnProperty;return o(t,"addEventListener",function(n,r){u(this,e+n,r)}),o(t,"dispatchEvent",function(n){a(this,e+n.type,n)}),o(t,"removeEventListener",function(n,r){f(this,e+n,r)}),t};
export { EventTarget }

