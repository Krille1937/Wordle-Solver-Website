/**
 * Solver.js - Wordle Solver engine (Javascript port of Java)
 * 
 * Handles:
 *  - Constraint tracking for Green / Yellow / Gray clues
 *  - Duplicate-letter logic (same two-pass algoritm as my Java version)
 *  - Candidate filtering using pre-computed Uint8Array letter counts
 *  - Frequency scoring   when remaining > ENTROPY_THRESHOLD   (0(N), instant)
 *  - Entropy scoring   when remaining ≤ ENTROPY_THRESHOLD   (O(N×R), ~200ms)
 * 
 * @version 1.1.0
 * @author Kristoffer Oltegen Diehl
 */

'use strict';

const ENTROPY_THRESHOLD = 750; // When to switch from frequency to entropy scoring   (words left)

class WordleSolver {

  // ─── Constructor ───────────────────────────────────────────────────────────

  constructor(words) {
    this.allWords = words;
    const n = words.length;
 
    // Pre-compute letter counts for every word.
    // letterCounts[i] is a Uint8Array[26] where index c = letter (char - 97).
    // Built once here; reused in every filter + scoring call.
    this.letterCounts = new Array(n);
    for (let i = 0; i < n; i++) {
      const counts = new Uint8Array(26);
      const w = words[i];
      for (let p = 0; p < 5; p++) counts[w.charCodeAt(p) - 97]++;
      this.letterCounts[i] = counts;
    }
 
    // ── Constraint state (all primitives, no object lookups in hot path) ──
    this.green    = new Array(5).fill(null);      // confirmed letter per position
    this.minCount = new Int32Array(26);            // min required occurrences
    this.maxCount = new Int32Array(26).fill(5);    // max allowed (default = unconstrained)
    this.forbidden = Array.from({ length: 5 },    // forbidden[pos][c] = must-not-be
                                () => new Uint8Array(26));
 
    // Remaining candidate indices (compacted in-place — no reallocation)
    this.remainingIdx  = new Int32Array(Array.from({ length: n }, (_, i) => i));
    this.remainingSize = n;

    // 0(1) word => index lookup (used by scoreWord for training mode)
    this._wordIndexMap = new Map(words.map((w, i) => [w, i]));
 
    // ── Reusable scratch buffers (avoids allocations inside hot loops) ─────
    this._avail   = new Int32Array(26); // pattern computation
    this._buckets = new Int32Array(243); // entropy scoring
    this._seen    = new Uint8Array(26);  // frequency scoring unique-letter guard
  }
 
  // ─── Applying a Guess ──────────────────────────────────────────────────────
 
  /**
   * Record a guess + result and update all constraints.
   *
   * @param {string}   guess  - 5-letter lowercase word
   * @param {string[]} result - ['G','Y','X', ...] for each of the 5 positions
   */
  applyGuess(guess, result) {
    // Count G/Y occurrences per letter in this specific guess
    // (tells us the confirmed minimum count for that letter)
    const confirmed = new Int32Array(26);
    for (let i = 0; i < 5; i++) {
      if (result[i] !== 'X') confirmed[guess.charCodeAt(i) - 97]++;
    }
 
    // Update constraint arrays
    for (let i = 0; i < 5; i++) {
      const c    = guess.charCodeAt(i) - 97;
      const clue = result[i];
 
      if (clue === 'G') {
        this.green[i] = guess[i];
        this.minCount[c] = Math.max(this.minCount[c], confirmed[c]);
 
      } else if (clue === 'Y') {
        this.forbidden[i][c] = 1;
        this.minCount[c] = Math.max(this.minCount[c], confirmed[c]);
 
      } else { // 'X'
        // Gray: word has no MORE copies than what G/Y already confirmed.
        // This correctly handles duplicates (e.g. "speed" vs "spell").
        this.maxCount[c] = Math.min(this.maxCount[c], confirmed[c]);
      }
    }
 
    this._refilter();
  }
 
  // ─── Candidate Filtering ───────────────────────────────────────────────────
 
  /** Compacts remainingIdx[] in-place. Zero heap allocations. */
  _refilter() {
    let write = 0;
    for (let ri = 0; ri < this.remainingSize; ri++) {
      const idx = this.remainingIdx[ri];
      if (this._matches(idx)) this.remainingIdx[write++] = idx;
    }
    this.remainingSize = write;
  }
 
  /**
   * Tests one word against all current constraints.
   * This is the innermost hot-loop — every operation is a primitive.
   */
  _matches(idx) {
    const w    = this.allWords[idx];
    const freq = this.letterCounts[idx];
 
    // 1. Green: confirmed positions must match
    for (let p = 0; p < 5; p++) {
      if (this.green[p] !== null && w[p] !== this.green[p]) return false;
    }
 
    // 2. Forbidden positions (Yellow constraint)
    for (let p = 0; p < 5; p++) {
      if (this.forbidden[p][w.charCodeAt(p) - 97]) return false;
    }
 
    // 3. Letter count min/max
    for (let c = 0; c < 26; c++) {
      if (freq[c] < this.minCount[c]) return false;
      if (freq[c] > this.maxCount[c]) return false;
    }
 
    return true;
  }
 
  // ─── Pattern Computation ───────────────────────────────────────────────────
 
  /**
   * Computes the Wordle result pattern for (guess at gIdx) vs (answer at aIdx).
   * Returns an integer 0–242 encoding the pattern in base 3:
   *   G=2, Y=1, X=0  →  value = r[0]·81 + r[1]·27 + r[2]·9 + r[3]·3 + r[4]
   *
   * Two-pass duplicate-letter algorithm:
   *   Pass 1: mark Greens, subtract from answer's available letter pool
   *   Pass 2: mark Yellows only if answer still has unused copies of that letter
   *
   * Uses this._avail as a reusable scratch buffer — no allocations.
   */
  _computePattern(gIdx, aIdx) {
    const g = this.allWords[gIdx];
    const a = this.allWords[aIdx];
    const av = this._avail;
 
    // Build available-letter pool from the answer (only touch the 5 letters used)
    const a0 = a.charCodeAt(0)-97, a1 = a.charCodeAt(1)-97, a2 = a.charCodeAt(2)-97,
          a3 = a.charCodeAt(3)-97, a4 = a.charCodeAt(4)-97;
    av[a0] = 0; av[a1] = 0; av[a2] = 0; av[a3] = 0; av[a4] = 0;
    av[a0]++; av[a1]++; av[a2]++; av[a3]++; av[a4]++;
 
    const g0 = g.charCodeAt(0)-97, g1 = g.charCodeAt(1)-97, g2 = g.charCodeAt(2)-97,
          g3 = g.charCodeAt(3)-97, g4 = g.charCodeAt(4)-97;
 
    let r0 = 0, r1 = 0, r2 = 0, r3 = 0, r4 = 0;
 
    // Pass 1: Greens consume available slots
    if (g0 === a0) { r0 = 2; av[g0]--; }
    if (g1 === a1) { r1 = 2; av[g1]--; }
    if (g2 === a2) { r2 = 2; av[g2]--; }
    if (g3 === a3) { r3 = 2; av[g3]--; }
    if (g4 === a4) { r4 = 2; av[g4]--; }
 
    // Pass 2: Yellows only if a slot remains
    if (r0 === 0 && av[g0] > 0) { r0 = 1; av[g0]--; }
    if (r1 === 0 && av[g1] > 0) { r1 = 1; av[g1]--; }
    if (r2 === 0 && av[g2] > 0) { r2 = 1; av[g2]--; }
    if (r3 === 0 && av[g3] > 0) { r3 = 1; av[g3]--; }
    if (r4 === 0 && av[g4] > 0) { r4 = 1; av[g4]--; }
 
    return r0*81 + r1*27 + r2*9 + r3*3 + r4;
  }
 
  // ─── Recommendation Engine ─────────────────────────────────────────────────
 
  /**
   * Returns the top N best guesses. Auto-selects scoring mode:
   *   remaining > 500  →  frequency scoring  (instant)
   *   remaining ≤ 500  →  entropy scoring    (~100–300ms)
   */
  getRecommendations(topN = 7, onlyPossible = false) {
    if (this.remainingSize === 0) return [];
    if (this.remainingSize === 1) {
      return [{
        word:              this.allWords[this.remainingIdx[0]],
        score:             Infinity,
        expectedRemaining: 0,
        worstCase:         1,
        isPossible:        true,
        mode:              'certain',
      }];
    }
 
    return this.remainingSize <= ENTROPY_THRESHOLD
      ? this._scoreByEntropy(topN, onlyPossible)
      : this._scoreByFrequency(topN, onlyPossible);
  }
 
  /**
   * Entropy scoring — information-theoretic optimal.
   *
   * For each candidate guess: simulate what result pattern it would produce
   * against every remaining answer. Count how many answers fall into each
   * of the 243 possible pattern buckets.
   *
   * H(guess) = Σ [ count · log(R / count) ] / R
   *
   * Higher H = more information gained = fewer guesses needed on average.
   * Also computes expectedRemaining and worstCase for display.
   */
  _scoreByEntropy(topN, onlyPossible = false) {
    const R    = this.remainingSize;
    const logR = Math.log(R);
    const bk   = this._buckets;
 
    // O(1) lookup for "is this word still a possible answer?"
    const isPossible = new Uint8Array(this.allWords.length);
    for (let ri = 0; ri < R; ri++) isPossible[this.remainingIdx[ri]] = 1;

    // When onlyPossible=true, only score candidates from the remaining set.
    // Also faster: O(R²) instead of O(N×R)
    const pool = onlyPossible
      ? Array.from({ length: R }, (_, i) => this.remainingIdx[i])
      : Array.from({ length: this.allWords.length }, (_, i) => i);

    const results = new Array(pool.length);
 
    for (let pi = 0; pi < pool.length; pi++) {
      const gi = pool[pi]
      // Fill buckets for this guess vs all remaining candidates
      bk.fill(0);
      for (let ri = 0; ri < R; ri++) {
        bk[this._computePattern(gi, this.remainingIdx[ri])]++;
      }
 
      let entropy = 0, expRem = 0, worst = 0;
      for (let b = 0; b < 243; b++) {
        const c = bk[b];
        if (c > 0) {
          entropy += c * (logR - Math.log(c));
          expRem  += c * c;
          if (c > worst) worst = c;
        }
      }
 
      results[pi] = {
        word:              this.allWords[gi],
        score:             entropy / R,
        expectedRemaining: expRem / R,
        worstCase:         worst,
        isPossible:        isPossible[gi] === 1,
        mode:              'entropy',
      };
    }
 
    // Sort: highest entropy first; possible answers win ties
    results.sort((a, b) =>
      b.score - a.score || (a.isPossible === b.isPossible ? 0 : a.isPossible ? -1 : 1)
    );

    // Feature 1 fix: when candidates < topN, don't pad with non-possible words.
    // Showing dictionary words below the 2-3 real options is noise, not signal.
    if (!onlyPossible && this.remainingSize < topN) {
      return results.filter(r => r.isPossible).slice(0, topN);
    }
    return results.slice(0, topN);
  }
 
  /**
   * Frequency scoring — fast O(N) heuristic.
   *
   * freq[c] = number of remaining words containing letter c.
   * score(word) = sum of freq[c] for each UNIQUE letter in the word.
   * (Duplicates in a guess test nothing extra, so they're not double-counted.)
   */
  _scoreByFrequency(topN, onlyPossible = false) {
    const freq = new Int32Array(26);
    for (let ri = 0; ri < this.remainingSize; ri++) {
      const lc = this.letterCounts[this.remainingIdx[ri]];
      for (let c = 0; c < 26; c++) if (lc[c] > 0) freq[c]++;
    }
 
    const isPossible = new Uint8Array(this.allWords.length);
    for (let ri = 0; ri < this.remainingSize; ri++) isPossible[this.remainingIdx[ri]] = 1;
 
    const seen = this._seen;
    const pool = onlyPossible
      ? Array.from({ length: this.remainingSize }, (_, i) => this.remainingIdx[i])
      : Array.from({ length: this.allWords.length }, (_, i) => i);

    const results = new Array(pool.length);
 
    for (let pi = 0; pi < pool.length; pi++) {
      const i = pool[pi];
      const w = this.allWords[i];
      seen.fill(0);
      let score = 0;
      for (let p = 0; p < 5; p++) {
        const c = w.charCodeAt(p) - 97;
        if (!seen[c]) { seen[c] = 1; score += freq[c]; }
      }
      results[pi] = { word: w, score, isPossible: isPossible[i] === 1, mode: 'frequency' };
    }
 
    results.sort((a, b) =>
      b.score - a.score || (a.isPossible === b.isPossible ? 0 : a.isPossible ? -1 : 1)
    );

    if (!onlyPossible && this.remainingSize < topN) {
      return results.filter(r => r.isPossible).slice(0, topN);
    }
    return results.slice(0, topN);
  }
 
  // ─── Analysis Helpers ──────────────────────────────────────────────────────
 
  /**
   * Letter frequency across remaining candidates.
   * Returns Int32Array[26] where freq[c] = count of remaining words containing letter c.
   */
  getLetterFrequency() {
    const freq = new Int32Array(26);
    for (let ri = 0; ri < this.remainingSize; ri++) {
      const lc = this.letterCounts[this.remainingIdx[ri]];
      for (let c = 0; c < 26; c++) if (lc[c] > 0) freq[c]++;
    }
    return freq;
  }
 
  /**
   * Best-known state for every letter of the alphabet — used to colour the keyboard.
   * Priority: green > yellow > gray > undefined (not yet guessed)
   * Returns an object: { 'a': 'green', 'b': 'gray', ... }
   */
  getLetterStates() {
    const states = {};
 
    // Gray: letter has been entirely eliminated (maxCount = 0)
    for (let c = 0; c < 26; c++) {
      if (this.maxCount[c] === 0) states[String.fromCharCode(97 + c)] = 'gray';
    }
 
    // Yellow: letter is confirmed present (minCount > 0) but not yet placed
    for (let c = 0; c < 26; c++) {
      const letter = String.fromCharCode(97 + c);
      if (this.minCount[c] > 0 && !states[letter]) states[letter] = 'yellow';
    }
 
    // Green: letter confirmed at a specific position (overrides yellow)
    for (let p = 0; p < 5; p++) {
      if (this.green[p] !== null) states[this.green[p]] = 'green';
    }
 
    return states;
  }
 
  // ─── Getters ───────────────────────────────────────────────────────────────
 
  get remainingCount() { return this.remainingSize; }
  get totalWords()     { return this.allWords.length; }
  get scoringMode()    { return this.remainingSize <= ENTROPY_THRESHOLD ? 'entropy' : 'frequency'; }

  /**
   * Computes the Wordle result for a guess against a known answer.
   * Returns a 5-element array of 'G' | 'Y' | 'X'.
   * 
   * Uses the same two-pass duplicate letter algorithm as _computePattern,
   * but works directly with strings - no index lookup needed.
   * 
   * Used by training mode to simulate wordle feedback automatically.
   */
  computeResult(guessWord, answerWord) {
    const result = ['X','X','X','X','X'];
    const avail = new Int32Array(26);

    // Count all letters in the answer
    for (let i = 0; i < 5; i++) avail[answerWord.charCodeAt(i) - 97]++;

    // Pass 1: Greens - exact matches consume an available slot
    for (let i = 0; i < 5; i++) {
      if (guessWord[i] === answerWord[i]) {
        result[i] = 'G';
        avail[guessWord.charCodeAt(i) - 97]--;
      }
    }

    // Pass 2: Yellows - present but wrong position, only if slots remain
    for (let i = 0; i < 5; i++) {
      if (result[i] !== 'G') {
        const c = guessWord.charCodeAt(i) - 97;
        if (avail[c] > 0) { result[i] = 'Y'; avail[c]--; }
      }
    }

    return result;
  }


  getRemainingWords() {
    const out = [];
    for (let ri = 0; ri < this.remainingSize; ri++) {
      out.push(this.allWords[this.remainingIdx[ri]]);
    }
    return out;
  }

  /**
   * Computes the entropy of ONE specific word against the current remaining candidates.
   * O(R) - Fast enough to call inline during training mode rating.
   * 
   * Returns null if the word isn't in the dictionary.
   * Returns { entropy, expectedRemaining, worstCase, isPossible } otherwise.
   * 
   * entropy is in nats. The theoretical maximum is Math.log(remainingSize).
   * quality = entropy / Math.log(remainingSize)  gives a 0-1 score.
   */
  scoreWord(word) {
    const idx = this._wordIndexMap.get(word);
    if (idx === undefined) return null;

    const R = this.remainingSize;
    if (R === 0) return null;
    if (R === 1) {
      return { entropy: 0, expectedRemaining: 1, worstCase: 1,
                isPossible: this.remainingIdx[0] === idx };
    }

    const logR = Math.log(R);
    const bk = this._buckets;
    bk.fill(0);

    for (let ri = 0; ri < R; ri++) {
      bk[this._computePattern(idx, this.remainingIdx[ri])]++;
    }

    let entropy = 0, expRem = 0, worst = 0;
    for (let b = 0; b < 243; b++) {
      const c = bk[b];
      if (c > 0) {
        entropy += c *(logR - Math.log(c));
        expRem += c * c;
        if (c > worst) worst = c;
      }
    }

    // Check if this word is still a possible answer
    let isPossible = false;
    for (let ri = 0; ri < R; ri++) {
      if (this.remainingIdx[ri] === idx) { isPossible = true; break; }
    }

    return {
      entropy: entropy / R,
      expectedRemaining: expRem / R,
      worstCase: worst,
      isPossible
    };
  }
}
