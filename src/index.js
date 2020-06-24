import _ from 'lodash'
// import { nijou, name } from './utilities'
import * as utilities from './utilities'

console.log(utilities.nijou(3))
console.log(utilities.name)

function component() {
  const element = document.createElement('div');
  const array = ['Hello', 'webpack', '!!'];
  element.innerHTML = _.join(array, ' ')
  return element;
}

document.body.appendChild(component());