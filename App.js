/**
 * App.js - Wordle Solver UI controller
 * 
 * Responsibile for:
 *      - Loading words.txt via fetch()
 *      - Managing guess state (typed word + tile colors)
 *      - Submitting guesses and applying them to Solver.js
 *      - Rendering: guess grid, color tiles, keyboard, recommendations, frequency chart
 *      - Solved overlay + reset flow
 * 
 * Requires: Solver.js loaded first (provides WordleSolver class)
 * 
 * @version 2.0.0
 * @author: Kristoffer Oltegen Diehl
 */

'use strict';

// Config
const MAX_GUESSES = 6;
const WORD_FILE = 'words.txt';
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const COLOR_LABELS = { 'X': 'gray', 'Y': 'yellow', 'G': 'green' };

// App State
let solver = null;
let words = [];

const state = {
    guessHistory:   [],
    currentWord:    '',
    currentColors:  Array(5).fill('X'),
    isComputing:    false,
    isSolved:       false,
    onlyPossible:   false,
    trainingMode:   false,
    secretWord:     null,
    guessRatings:   [],
    isRating:       false,
};

// Init
async function init() {
    buildKeyboard();
    renderGrid();
    bindEvents();

    try {
        const res = await fetch(WORD_FILE);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();

        words = text.split('\n')
            .map(w => w.trim().toLowerCase())
            .filter(w => /^[a-z]{5}$/.test(w));

        if (words.length === 0) throw new Error('Word list is empty or invalid');

        solver = new WordleSolver(words);

        document.getElementById('word-count').textContent = words.length.toLocaleString();
        updateStatus();
        computeAndRender();

    } catch (err) {
        showError(`<small style="color:var(--text-muted)">${err.message}</small>`);
    }
}

// Event Binding
function bindEvents() {
    const input = document.getElementById('guess-input');
    input.addEventListener('input', onInputChange);
    input.addEventListener('keydown', e => { if (e.key == 'Enter') submitGuess(); });

    document.getElementById('submit-btn')
            .addEventListener('click', submitGuess);
    document.getElementById('reset-btn')
            .addEventListener('click', resetGame);
    document.getElementById('solved-reset-btn')
            .addEventListener('click', resetGame);
    document.getElementById('only-possible-btn')
            .addEventListener('click', toggleOnlyPossible);
    document.getElementById('training-mode-btn')
            .addEventListener('click', toggleTrainingMode);

    // Color-tile clicks
    document.querySelectorAll('#color-tiles .ctile').forEach(tile => {
        tile.addEventListener('click', () => cycleTileColor(tile.dataset.pos));
    });
}

// Input Handling
function onInputChange(e) {
    // Strip non-letters and limit to 5 chars, uppercase display
    const clean = e.target.value.replace(/[^a-zA-Z]/g, '').slice(0, 5).toLowerCase();
    e.target.value = clean.toUpperCase();
    state.currentWord = clean;

    if (!state.trainingMode) updateColorTileLetters();
    updateSubmitButton();
}

function updateColorTileLetters() {
    document.querySelectorAll('#color-tiles .ctile').forEach((tile, i) => {
        const letter = state.currentWord[i];
        tile.textContent = letter ? letter.toUpperCase() : '';

        // The tile is only interactable once it has a letter
        if (letter) {
            tile.dataset.letter = letter;
        } else {
            delete tile.dataset.letter;
            state.currentColors[i] = 'X';
        }

        // Keep color class in sync
        tile.dataset.color = state.currentColors[i];

        const label = tile.closest('.ctile-wrap')?.querySelector('.ctile-label');
        if (label) label.textContent = COLOR_LABELS[state.currentColors[i]];
    });
}

function updateSubmitButton() {
    document.getElementById('submit-btn').disabled =
        state.currentWord.length !== 5 || state.isSolved || !solver || state.isComputing || state.isRating;
}

// Color Tile Cycling
/**
 * Cycles the color for position 'pos': X → Y → G → X
 * Only active when that position has a letter.
 */
function cycleTileColor(pos) {
    if (state.trainingMode || !state.currentWord[pos]) return;

    const CYCLE = { 'X': 'Y', 'Y' : 'G', 'G' : 'X' };
    state.currentColors[pos] = CYCLE[state.currentColors[pos]];
    const color = state.currentColors[pos];

    const tile = document.querySelector(`#color-tiles .ctile[data-pos="${pos}"]`);
    const label = tile.closest('.ctile-wrap')?.querySelector('.ctile-label');
    tile.dataset.color = state.currentColors[pos];
    if (label) label.textContent = COLOR_LABELS[color];
}

// Submit a Guess
function submitGuess() {
    if (!solver || state.currentWord.length !== 5 || state.isSolved) return;
    if (state.isComputing || state.isRating) return;
    const word = state.currentWord;
    if (state.trainingMode) submitTrainingGuess(word);
    else                    submitSolverGuess(word);
}

// Solver mode
function submitSolverGuess(word) {
    const result = [...state.currentColors];
    const solved = result.every(r => r === 'G');

    state.guessHistory.push({ word, result });
    solver.applyGuess(word, result);

    state.currentWord = '';
    state.currentColors = Array(5).fill('X');
    document.getElementById('guess-input').value = '';
    updateColorTileLetters();
    updateSubmitButton();
    renderGrid();
    updateKeyboard();
    updateStatus();

    if (solved) { state.isSolved = true; setTimeout(() => showSolvedOverlay(state.guessHistory.length), 600); return; }
    if (state.guessHistory.length >= MAX_GUESSES) { showError(`Out of guesses!<br><small>${solver.remainingCount.toLocaleString()} candidates remained.</small>`); return; }
    computeAndRender();
}

function submitTrainingGuess(word) {
    // Autocompute result against the secret word
    const result = solver.computeResult(word, state.secretWord);
    const remainingBefore = solver.remainingCount;
    const solved = result.every(r => r === 'G');

    state.guessHistory.push({ word, result });
    // Push a placeholder - rating is filled in async computeTrainingRating
    state.guessRatings.push({ word, result, remainingBefore, rating: null, bestRecs: null });

    solver.applyGuess(word, result);

    state.currentWord = '';
    document.getElementById('guess-input').value = '';
    updateSubmitButton();
    renderGrid();
    updateKeyboard();
    updateStatus();

    const ratingIdx = state.guessRatings.length - 1;

    if (solved) {
        state.isSolved = true;
        computeTrainingRating(ratingIdx, () =>
            setTimeout(() => showSolvedOverlay(state.guessHistory.length), 600));
        return;
    }

    if (state.guessHistory.length >= MAX_GUESSES) {
        computeTrainingRating(ratingIdx, () => showTrainingGameOver());
        return;
    }

    computeTrainingRating(ratingIdx);
}

// Training Rating (async)
/**
 * Rates the guess at guessRatings[idx] by replaying history on a temporary
 * solver to get teh pre-guess state, then scoring the word's entropy and
 * computing the top-3 best alternatives that existed at that point. 
 */
function computeTrainingRating(idx, onDone) {
    state.isRating = true;
    updateSubmitButton();
    renderTrainingPanel(true);

    setTimeout (() => {
        try {
            const entry = state.guessRatings[idx];
            if (!entry) return;

            // Replay history BEFORE this guess to reconstruct the pre-guess solver state
            const ratingHistory = state.guessHistory.slice(0, idx);
            const ratingSolver = new WordleSolver(words);
            for (const h of ratingHistory) ratingSolver.applyGuess(h.word, h.result);

            const userScore = ratingSolver.scoreWord(entry.word);
            const topRecs = ratingSolver.getRecommendations(3, false);
            const rating = buildRating(entry.word, userScore, entry.remainingBefore);

            state.guessRatings[idx] = { ...entry, rating, bestRecs: topRecs };

        } catch (err) {
            console.error('Rating error:', err);
        } finally {
            state.isRating = false;
            updateSubmitButton();
            renderTrainingPanel(false);
            if (onDone) onDone();
        }
    }, 20);
}

function buildRating(word, score, remaining) {
    if (remaining === 1) {
        return { quality: 1.0, label: 'Only Option', stars: 3, colorClass: 'rating-green',
                    detail: 'Only one candidate remained.' };
    }
    if (!score) {
        return { quality: null, label: 'Unknown Word', stars: 0, colorClass: 'rating-muted',
                    detail: 'Word not in dictionary - no rating.' };
    }
    if (remaining === 2) {
        return { quality: score.entropy / Math.log(2), label: 'Coin Flip', stars: 2,
                    colorClass: 'rating-yellow', entropy: score.entropy,
                    maxEntropy: Math.log(2), isPossible: score.isPossible,
                    detail: 'Only 2 candidates - either is a 50/50.' };
    }

    const maxEntropy = Math.log(remaining);
    const quality = score.entropy / maxEntropy;
    let label, stars, colorClass;
    if      (quality >= 0.90) { label = 'Optimal';  stars = 3; colorClass = 'rating-green';  }
    else if (quality >= 0.72) { label = 'Strong';   stars = 3; colorClass = 'rating-green';  }
    else if (quality >= 0.55) { label = 'Good';     stars = 2; colorClass = 'rating-yellow'; }
    else if (quality >= 0.35) { label = 'Weak';     stars = 1; colorClass = 'rating-orange'; }
    else                      { label = 'Poor';     stars = 0; colorClass = 'rating-red';    }

    return { quality, label, stars, colorClass, isPossible: score.isPossible,
                entropy: score.entropy, maxEntropy,
                detail: `${Math.round(quality * 100)}% of max entropy` };
}

// Compute Recommendations
/**
 * Yields to the browser (shows loading spinner),
 * then runs the solver synchronously and renders results.
 * 
 * The setTimeout(fn, 0) pattern lets the DOM repaint before we block.
 * For remaining > 500 this is  instant anyway (frequency mode).
 * For remaining ≤ 500 it can take ~100-300ms (entropy mode).
 */
function computeAndRender() {
    if (state.trainingMode || state.isComputing) return;
    state.isComputing = true;
    setRecommendationsLoading();

    setTimeout(() => {
        try {
            const recs = solver.getRecommendations(8, state.onlyPossible);
            renderRecommendations(recs);
            renderFreqChart(solver.getLetterFrequency());
            updateScoringPill();
        } catch (err) {
            showError(`Solver Error: ${err.message}`);
        } finally {
            state.isComputing = false;
        }
    }, 20);
}

// Render: Recommendations Table
function setRecommendationsLoading() {
    document.getElementById('rec-body').innerHTML = `
        <div class="spinner-wrap"><span class="spinner"></span><span class="spinner-label">Computing…</span></div>`;
    document.getElementById('rec-legend').innerHTML = '';
}

function renderRecommendations(recs) {
    const body = document.getElementById('rec-body'), legend = document.getElementById('rec-legend');
    if (!recs || recs.length === 0) { body.innerHTML = `<div class="spinner-wrap" style="color:var(--text-muted)">No candidates remaining.</div>`; legend.innerHTML = ''; return; }
 
    const mode = recs[0].mode, isEntropy = mode === 'entropy' || mode === 'certain';
    let html = `<table class="rec-table"><thead><tr><th></th><th>Word</th>`;
    if (isEntropy) html += `<th class="r title-entropy" title="Information gained">Entropy</th><th class="r title-exp" title="Expected candidates remaining">Exp. left</th><th class="r" title="Worst-case candidates">Worst</th>`;
    else           html += `<th class="r" title="Letter frequency coverage">Coverage</th>`;
    html += `</tr></thead><tbody>`;
 
    recs.forEach((rec, i) => {
        const star = rec.isPossible ? `<span class="word-star" title="Still a possible answer">★</span>` : '';
        html += `<tr class="rec-row"><td class="td-rank">${i + 1}</td><td><div class="td-word"><span class="word-text">${rec.word.toUpperCase()}</span>${star}</div></td>`;
        if (mode === 'certain') html += `<td class="r td-entropy" colspan="${isEntropy ? 3 : 1}" style="color:var(--green)">Only candidate ✓</td>`;
        else if (isEntropy)     html += `<td class="r td-entropy">${rec.score.toFixed(3)}</td><td class="r td-exp">~${rec.expectedRemaining.toFixed(1)}</td><td class="r td-worst">≤${rec.worstCase}</td>`;
        else                    html += `<td class="r td-freq">${rec.score.toLocaleString()}</td>`;
        html += `</tr>`;
    });
 
    html += `</tbody></table>`;
    body.innerHTML = html;
    legend.innerHTML = isEntropy
        ? `<span><span class="legend-star">★</span> = still a possible answer</span><span>Entropy: higher → better</span><span>Exp. left: closer to 1 → better</span><span>Worst ≤1 → answer guaranteed next</span>`
        : `<span><span class="legend-star">★</span> = still a possible answer</span><span>Coverage: letters shared with remaining words</span><span>Entropy activates when ≤${ENTROPY_THRESHOLD} candidates remain</span>`;
}

// Render: Frequency Chart
function renderFreqChart(freqArray) {
    const el = document.getElementById('freq-chart');
    if (!freqArray || !solver || solver.remainingCount === 0) { el.innerHTML = ''; return; }
    const total = solver.remainingCount;
    const entries = Array.from({ length: 26 }, (_, c) => ({ letter: String.fromCharCode(97 + c), pct: Math.round(100 * freqArray[c] / total), count: freqArray[c] }))
        .filter(e => e.count > 0).sort((a, b) => b.count - a.count);
    el.innerHTML = entries.map(({ letter, pct }) => {
        const tier = pct >= 65 ? 'tier-high' : pct >= 35 ? 'tier-mid' : 'tier-low';
        return `<div class="freq-row"><span class="freq-letter">${letter}</span><div class="freq-track"><div class="freq-bar ${tier}" style="width:${pct}%"></div></div><span class="freq-pct">${pct}%</span></div>`;
    }).join('');
}

// Render: Guess Grid
function renderGrid() {
    const grid = document.getElementById('guess-grid');
    grid.innerHTML = '';
    for (let row = 0; row < MAX_GUESSES; row++) {
        const rowEl = document.createElement('div');
        rowEl.className = 'grid-row';
        const guess = state.guessHistory[row], isNew = row === state.guessHistory.length - 1;
        for (let col = 0; col < 5; col++) {
            const tile = document.createElement('div');
            tile.className = 'tile';
            if (guess) {
                const color = resultToClass(guess.result[col]);
                tile.textContent = guess.word[col].toUpperCase();
                if (isNew) { tile.style.animationDelay = `${col * 80}ms`; tile.classList.add('flip'); setTimeout(() => tile.classList.add(color), col * 80 + 200); }
                else tile.classList.add(color);
            }
            rowEl.appendChild(tile);
        }
        grid.appendChild(rowEl);
    }
}

function resultToClass(r) { return r === 'G' ? 'green' : r === 'Y' ? 'yellow' : 'gray'; }

// Render: Keyboard
function buildKeyboard() {
    KEYBOARD_ROWS.forEach((row, i) => {
        const rowEl = document.getElementById(`kr-${i}`);
        rowEl.innerHTML = '';
        for (const letter of row) {
            const key = document.createElement('div');
            key.className = 'key'; key.textContent = letter.toUpperCase(); key.id = `key-${letter}`;
            rowEl.appendChild(key);
        }
    });
}
 
function updateKeyboard() {
    if (!solver) return;
    const states = solver.getLetterStates();
    for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
        const el = document.getElementById(`key-${letter}`);
        if (!el) continue;
        el.className = 'key' + (states[letter] ? ` ${states[letter]}` : '');
    }
}

// Status / Pills
function updateStatus() {
    const label = document.getElementById('remaining-label'), pill = document.getElementById('mode-pill');
    if (!solver) { label.textContent = 'Loading…'; pill.textContent = ''; pill.className = 'pill loading'; return; }
    const n = solver.remainingCount, total = solver.totalWords;
    label.innerHTML = state.trainingMode
        ? `<strong>${n.toLocaleString()}</strong> candidates left`
        : `<strong>${n.toLocaleString()}</strong> / ${total.toLocaleString()} candidates remaining`;
    const mode = solver.scoringMode;
    pill.textContent = mode === 'entropy' ? '🧮 Entropy' : '📈 Frequency';
    pill.className   = `pill ${mode}`;
    document.getElementById('header-mode').textContent = mode === 'entropy' ? 'entropy mode' : 'frequency mode';
}

function updateScoringPill() {
    if (!solver) return;
    const mode = solver.scoringMode, pill = document.getElementById('scoring-pill');
    pill.textContent = mode === 'entropy' ? '🧮 Entropy' : '📈 Frequency';
    pill.className   = `pill pill-sm ${mode}`;
}

function toggleOnlyPossible() {
    state.onlyPossible = !state.onlyPossible;
    document.getElementById('only-possible-btn').classList.toggle('active', state.onlyPossible);
    if (!state.trainingMode) computeAndRender();
}

function toggleTrainingMode() {
    state.trainingMode = !state.trainingMode;
    const btn = document.getElementById('training-mode-btn');
    btn.classList.toggle('active', state.trainingMode);
    btn.textContent = state.trainingMode ? '🎯 Training ON' : '🎯 Training';
 
    document.getElementById('solver-right-col').classList.toggle('hidden', state.trainingMode);
    document.getElementById('training-panel-wrap').classList.toggle('hidden', !state.trainingMode);
 
    const colorSection = document.getElementById('color-input-section');
    const trainingHint = document.getElementById('training-input-hint');
    if (colorSection) colorSection.classList.toggle('hidden', state.trainingMode);
    if (trainingHint) trainingHint.classList.toggle('hidden', !state.trainingMode);
 
    if (state.trainingMode) {
        // Full reset with a new secret word
        solver              = new WordleSolver(words);
        state.secretWord    = words[Math.floor(Math.random() * words.length)];
        state.guessHistory  = [];
        state.guessRatings  = [];
        state.isSolved      = false;
        state.currentWord   = '';
        state.isRating      = false;
        document.getElementById('guess-input').value = '';
        document.getElementById('solved-overlay').classList.add('hidden');
        renderGrid();
        buildKeyboard();
        updateStatus();
        updateSubmitButton();
        renderTrainingPanel(false);
    } else {
        state.secretWord   = null;
        state.guessRatings = [];
        computeAndRender();
    }
}

function renderStars(n) {
    const c = Math.max(0, Math.min(3, n));
    return `<span class="stars-filled">${'★'.repeat(c)}</span><span class="stars-empty">${'☆'.repeat(3 - c)}</span>`;
}

function buildMiniTiles(word, result) {
    return result.map((r, i) => {
        const cls = r === 'G' ? 'green' : r === 'Y' ? 'yellow' : 'gray';
        return `<div class="mini-tile ${cls}">${word[i].toUpperCase()}</div>`;
    }).join('');
}

function renderTrainingPanel(computing) {
    const panel = document.getElementById('training-panel');
    if (!panel) return;
 
    if (state.guessRatings.length === 0) {
        panel.innerHTML = `
            <div class="training-empty">
                <div class="training-empty-icon">🎯</div>
                <p class="training-empty-title">Training Mode Active</p>
                <p class="training-empty-sub">A secret word has been chosen. Type your guesses — the tiles colour automatically. Each guess is rated on how much information it provides, and you'll see what better options existed.</p>
            </div>`;
        return;
    }
 
    let html = '<div class="training-history">';
 
    state.guessRatings.forEach((entry, i) => {
        const { word, result, remainingBefore, rating, bestRecs } = entry;
        const isLast    = i === state.guessRatings.length - 1;
        const stillWaiting = isLast && computing;
 
        html += `<div class="training-entry">`;
 
        // Top row: mini tiles + rating
        html += `<div class="training-entry-top">
            <span class="training-guess-num">${i + 1}</span>
            <div class="mini-tile-row">${buildMiniTiles(word, result)}</div>`;
 
        if (stillWaiting) {
            html += `<span class="training-computing"><span class="spinner" style="width:12px;height:12px;border-width:1.5px;flex-shrink:0"></span> Rating…</span>`;
        } else if (rating) {
            const pctStr = rating.quality !== null ? Math.round(rating.quality * 100) + '%' : '';
            html += `<span class="training-stars">${renderStars(rating.stars)}</span>
                     <span class="training-label ${rating.colorClass}">${rating.label}</span>
                     <span class="training-quality-pct">${pctStr}</span>`;
        }
        html += `</div>`; // entry-top
 
        // Detail row + alternatives
        if (rating && !stillWaiting) {
            // Detail
            html += `<div class="training-detail">${rating.detail}`;
            if (rating.isPossible) html += ` · <span class="training-possible">★ was a possible answer</span>`;
            html += `<span class="training-remaining">${remainingBefore.toLocaleString()} candidates</span>`;
            html += `</div>`;
 
            // Better alternatives (skip for coin-flip, only-option, unknown)
            const showAlt = bestRecs && bestRecs.length > 0 && rating.quality !== null
                         && !['Coin Flip', 'Only Option', 'Unknown Word'].includes(rating.label);
 
            if (showAlt) {
                const userIsTop  = bestRecs[0].word === word;
                const userInTop3 = bestRecs.some(r => r.word === word);
 
                if (userIsTop) {
                    html += `<div class="training-better optimal-note">✓ Optimal — this was the best possible guess!</div>`;
                } else if (userInTop3) {
                    html += `<div class="training-better optimal-note">✓ Near-optimal — one of the top 3 picks.</div>`;
                } else {
                    // Show top alternatives with quality percentage
                    const mode      = bestRecs[0].mode;
                    const isEntropy = mode === 'entropy';
                    const maxE      = Math.log(remainingBefore);
 
                    const altHtml = bestRecs.map(rec => {
                        let pct;
                        if (isEntropy && maxE > 0) {
                            pct = Math.round((rec.score / maxE) * 100) + '%';
                        } else {
                            pct = rec.score.toLocaleString();
                        }
                        return `<span class="better-word">${rec.word.toUpperCase()}</span><span class="better-pct">${pct}</span>`;
                    }).join('<span class="better-sep">·</span>');
 
                    html += `<div class="training-better">Better: ${altHtml}</div>`;
                }
            }
        }
 
        html += `</div>`; // training-entry
    });
 
    html += '</div>';
 
    // Overall score strip
    const rated = state.guessRatings.filter(r =>
        r.rating != null
        && r.rating.quality !== null
        && !['Coin Flip', 'Unknown Word', 'Only Option'].includes(r.rating.label));
 
    if (rated.length > 0) {
        const avg    = rated.reduce((s, r) => s + r.rating.quality, 0) / rated.length;
        const avgPct = Math.round(avg * 100);
        let oLabel, oStars, oClass;
        if      (avg >= 0.85) { oLabel = 'Excellent';  oStars = 3; oClass = 'rating-green'; }
        else if (avg >= 0.65) { oLabel = 'Good';       oStars = 2; oClass = 'rating-yellow'; }
        else if (avg >= 0.45) { oLabel = 'Needs Work'; oStars = 1; oClass = 'rating-orange'; }
        else                  { oLabel = 'Poor';       oStars = 0; oClass = 'rating-red'; }
 
        html += `
            <div class="training-overall">
                <span class="training-overall-label">Overall</span>
                <span class="training-stars">${renderStars(oStars)}</span>
                <span class="training-label ${oClass}">${oLabel}</span>
                <span class="training-overall-pct">${avgPct}%</span>
            </div>`;
    }
 
    panel.innerHTML = html;
}

function showTrainingGameOver() {
    renderTrainingPanel(false);
    const panel = document.getElementById('training-panel');
    if (!panel) return;
    const el = document.createElement('div');
    el.className = 'training-game-over';
    el.innerHTML = `
        <div class="game-over-label">The word was</div>
        <div class="game-over-word">${(state.secretWord || '?????').toUpperCase()}</div>
        <button class="btn-primary" style="margin-top:0.75rem" onclick="resetGame()">Try Again</button>`;
    panel.appendChild(el);
}

// Solved Overlay
function showSolvedOverlay(guessCount) {
    let sub = `Solved in ${guessCount} guess${guessCount === 1 ? '' : 'es'}`;
    if (state.trainingMode) {
        sub += ` · Word: ${(state.secretWord || '').toUpperCase()}`;
        const rated = state.guessRatings.filter(r => r.rating != null && r.rating.quality !== null && !['Coin Flip', 'Unknown Word'].includes(r.rating.label));
        if (rated.length > 0) {
            const avg = rated.reduce((s, r) => s + r.rating.quality, 0) / rated.length;
            sub += ` · Score: ${Math.round(avg * 100)}%`;
        }
    }
    document.getElementById('solved-sub').textContent = sub;
    document.getElementById('solved-overlay').classList.remove('hidden');
}

// Error Display
function showError(html) {
    document.getElementById('rec-body').innerHTML = `
        <div class="spinner-wrap" style="flex-direction:column;gap:0.75rem;padding:2rem 1.5rem;text-align:center;color:#e57373;line-height:1.6">${html}</div>`;
}

// Reset
function resetGame() {
    if (!words.length) return;
 
    solver = new WordleSolver(words);
    state.guessHistory  = [];
    state.currentWord   = '';
    state.currentColors = Array(5).fill('X');
    state.isSolved      = false;
    state.isComputing   = false;
    state.isRating      = false;
    state.guessRatings  = [];
 
    document.getElementById('guess-input').value = '';
    document.getElementById('solved-overlay').classList.add('hidden');
 
    if (!state.trainingMode) updateColorTileLetters();
    updateSubmitButton();
    renderGrid();
    buildKeyboard();
    updateStatus();
 
    if (state.trainingMode) {
        state.secretWord = words[Math.floor(Math.random() * words.length)];
        renderTrainingPanel(false);
    } else {
        computeAndRender();
    }
}

// Bootstrap
document.addEventListener('DOMContentLoaded', init);
