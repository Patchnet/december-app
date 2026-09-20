import {test} from 'node:test'
import assert from 'node:assert/strict'
import {parseAppend} from '../lib/jev-router.mjs'
import {routingCases,contextFor} from './fixtures/jev-routing.mjs'
for(const example of routingCases)test(`routing corpus: ${example.text} ${example.duplicateDestination?'ambiguous name':example.doneDuplicate?'completed duplicate':''}`,()=>{
 assert.deepEqual(parseAppend(example.text,contextFor(example))||{action:'defer'},example.expected)
})
