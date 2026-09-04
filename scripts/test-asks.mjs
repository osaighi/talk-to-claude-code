#!/usr/bin/env node
// Detection of a session that stopped to ask the user something.
//
// This is a wording heuristic — nothing in the transcript marks a question — so
// the cases that matter are the awkward ones: a request that ends in a full
// stop, and a rhetorical question the session answers itself.
import { asksForInput } from '../dist/transcript.js'

const turn = text => [{ role: 'assistant', text }]

const cases = [
  ['Dis-moi lequel j\'attaque.', true, 'FR request, no question mark'],
  ['Veux-tu que je traite les deux items bloquants maintenant ?', true, 'FR question'],
  ['Prochain pas : politique de confidentialité ou signature release. Dis-moi lequel j\'attaque.', true, 'real case seen in the wild'],
  ['**Shall I proceed with the migration?**', true, 'EN question wrapped in markdown'],
  ['Let me know which one you prefer.', true, 'EN request'],
  ['Done: speed and limit moved top-right, pushed as 9e52cb3.', false, 'completed report'],
  ['I read all three files. There are 8 TypeScript files in src/.', false, 'plain answer'],
  ['Does it compare values? No — it compares two strings. Fixed and pushed.', false, 'rhetorical, answered in place'],
  ['', false, 'empty turn'],
]

let failed = 0
for (const [text, expected, why] of cases) {
  const got = asksForInput(turn(text))
  if (got !== expected) {
    failed++
    console.error(`FAIL  expected ${expected}, got ${got}: ${why}`)
  }
}
console.log(failed === 0 ? `ok — ${cases.length} cases` : `${failed} failing`)
process.exit(failed === 0 ? 0 : 1)
