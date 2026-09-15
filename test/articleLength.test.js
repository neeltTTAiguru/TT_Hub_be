import test from 'node:test'
import assert from 'node:assert/strict'
import { checkArticleLength, describeLengthCheck, lengthDirective, wordCount } from '../src/services/articleLength.js'

const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')

test('wordCount ignores markdown markers', () => {
  assert.equal(wordCount('# Title\n\n- **bold** item\n> quote here'), 5)
  assert.equal(wordCount(''), 0)
})

test('checkArticleLength flags short, ok and long against a ±15% band', () => {
  assert.equal(checkArticleLength(words(2000), 2000).status, 'ok')
  assert.equal(checkArticleLength(words(1700), 2000).status, 'ok')
  assert.equal(checkArticleLength(words(2300), 2000).status, 'ok')
  const long = checkArticleLength(words(3158), 2487)
  assert.equal(long.status, 'long')
  assert.equal(long.max, 2860)
  assert.equal(long.delta, 2860 - 3158)
  const short = checkArticleLength(words(1000), 2000)
  assert.equal(short.status, 'short')
  assert.equal(short.delta, 1700 - 1000)
})

test('checkArticleLength honours CONTENT_OPS_WORD_COUNT_TOLERANCE', () => {
  const previous = process.env.CONTENT_OPS_WORD_COUNT_TOLERANCE
  process.env.CONTENT_OPS_WORD_COUNT_TOLERANCE = '0.05'
  try {
    assert.equal(checkArticleLength(words(2200), 2000).status, 'long')
  } finally {
    if (previous === undefined) delete process.env.CONTENT_OPS_WORD_COUNT_TOLERANCE
    else process.env.CONTENT_OPS_WORD_COUNT_TOLERANCE = previous
  }
})

test('no Surfer target means nothing is enforced', () => {
  const check = checkArticleLength(words(500), null)
  assert.equal(check.status, 'unknown')
  assert.equal(check.ok, true)
  assert.equal(lengthDirective(check), '')
  assert.match(describeLengthCheck(check), /no word target/)
})

test('lengthDirective tells the reviser exactly how far to move', () => {
  const long = lengthDirective(checkArticleLength(words(3158), 2487))
  assert.match(long, /Cut at least 298 words/)
  assert.match(long, /2114–2860 words/)
  const short = lengthDirective(checkArticleLength(words(1000), 2000), ['How long is footage kept?'])
  assert.match(short, /Add at least 700 words/)
  assert.match(short, /How long is footage kept\?/)
  const ok = lengthDirective(checkArticleLength(words(2000), 2000))
  assert.match(ok, /Keep it there/)
})
