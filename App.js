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
 * @author: Kristoffer Oltegen Diehl
 */

'use strict';

// Config
const MAX_GUESSES = 6;
const WORD_FILE = 'words.txt';
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

// App State
let solver = null;
let words = [];

const state = {
    guessHistory:   [],
    currentWord:    '',
    currentColors:  Array(5).fill('X'),
    isComputing:    false,
    isSolved:       false,
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

    updateColorTileLetters();
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
        }

        // Keep color class in sync
        tile.dataset.color = state.currentColors[i];
    });
}

function updateSubmitButton() {
    document.getElementById('submit-btn').disabled =
        state.currentWord.length !== 5 || state.isSolved || !solver;
}

// Color Tile Cycling
/**
 * Cycles the color for position 'pos': X → Y → G → X
 * Only active when that position has a letter.
 */
function cycleTileColor(pos) {
    if (!state.currentWord[pos]) return;

    const CYCLE = { 'X': 'Y', 'Y' : 'G', 'G' : 'X' };
    state.currentColors[pos] = CYCLE[state.currentColors[pos]];

    const tile = document.querySelector(`#color-tiles .ctile[data-pos="${pos}"]`);
    tile.dataset.color = state.currentColors[pos];
}

// Submit a Guess
function submitGuess() {
    if (!solver || state.currentWord.length !== 5 || state.solved) return;

    const word = state.currentWord;
    const result =  [...state.currentColors];
    const solved = result.every(r => r === 'G');

    // Commit to history
    state.guessHistory.push({ word, result });

    // Apply constraints to the solver
    solver.applyGuess(word, result);

    // Clear input + reset colors to gray
    state.currentWord = '';
    state.currentColors = Array(5).fill('X');
    document.getElementById('guess-input').value = '';
    updateColorTileLetters();
    updateSubmitButton();

    // Re-render everything that depends on new state
    renderGrid();
    updateKeyboard();
    updateStatus();

    if (solved) {
        state.solved = true;
        setTimeout(() => showSolvedOverlay(state.guessHistory.length), 600);
        return;
    }

    if (state.guessHistory.length >= MAX_GUESSES) {
        showError(`Out of guesses! <br><small>${solver.remainingCount.toLocaleString()} candidates remained.</small>`);
        return;
    }

    computeAndRender();
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
    if (state.isComputing) return;
    state.isComputing = true;

    setRecommendationsLoading();

    setTimeout(() => {
        try {
            const recs = solver.getRecommendations(8);
            renderRecommendations(recs);
            renderFreqChart(solver.getLetterFrequency());
            updateScoringPill();
        } catch (err) {
            console.error('Solver error:', err);
            showError(`Solver Error: ${err.message}`);
        } finally {
            state.isComputing = false;
        }
    }, 20);
}

// Render: Recommendations Table
function setRecommendationsLoading() {
    document.getElementById('rec-body').innerHTML = `
        <div class="spinner-wrap">
            <span class="spinner"></span>
            <span class="spinner-label">Computing...</span>
        </div>`;
    document.getElementById('rec-legend').innerHTML = '';
}

function renderRecommendations(recs) {
    const body = document.getElementById('rec-body');
    const legend = document.getElementById('rec-legend');

    if (!recs || recs.length === 0) {
        body.innerHTML   = `<div class="spinner-wrap" style="color:var(--text-muted)">No candidates remaining.</div>`;
        legend.innerHTML = '';
        return;
    }

    const mode = recs[0].mode;
    const isEntropy = mode === 'entropy' || mode === 'certain';

    // Table header
    let html = `<table class="rec-table"><thead><tr>
        <th></th>
        <th>Word</th>`;
    
    if (isEntropy) {
        html += `
        <th class="r title-entropy" title="Bits of information gained — higher is better">Entropy</th>
        <th class="r title-exp"     title="Expected candidates remaining after this guess">Exp. left</th>
        <th class="r"               title="Candidates remaining in the worst-case outcome">Worst</th>`;
    } else {
        html += `<th class="r" title="Letter frequency coverage score — higher is better">Coverage</th>`;
    }

    html += `</tr></thead><tbody>`;

    // Table rows
    recs.forEach((rec, i) => {
        const star = rec.isPossible
            ? `<span class="word-star" title="This word is still a possible answer">★</span>`
            : '';
        
        html += `<tr class="rec-row">
            <td class="td-rank">${i + 1}</td>
            <td><div class="td-word">
                <span class="word-text">${rec.word.toUpperCase()}</span>${star}
            </div></td>`;
        
        if (mode === 'certain') {
            html += `<td class="r td-entropy" colspan="${isEntropy ? 3 : 1}" style="color:var(--green)">Only candidate ✓</td>`;

        } else if (isEntropy) {
            html += `
            <td class="r td-entropy">${rec.score.toFixed(3)}</td>
            <td class="r td-exp">~${rec.expectedRemaining.toFixed(1)}</td>
            <td class="r td-worst">≤${rec.worstCase}</td>`;
        } else {
            html += `<td class="r td-freq">${rec.score.toLocaleString()}</td>`;
        }

        html += `</tr>`;
    });

    html += `</tbody></table>`;
    body.innerHTML = html;

    // Legend
    if (isEntropy) {
        legend.innerHTML = `
            <span><span class="legend-star">★</span> = still a possible answer</span>
            <span title="Bits of information — higher = better">Entropy: higher → better guess</span>
            <span title="Average candidates left after this guess">Exp. left: closer to 1 → better</span>
            <span title="Most candidates in any single result bucket">Worst: ≤1 → answer guaranteed next</span>`;
    } else {
        legend.innerHTML = `
            <span><span class="legend-star">★</span> = still a possible answer</span>
            <span>Coverage: how many remaining words share these letters</span>
            <span>Entropy scoring activates when ≤ ${ENTROPY_THRESHOLD} candidates remain</span>`;
    }
}

// Render: Frequency Chart
function renderFreqChart(freqArray) {
    const el = document.getElementById('freq-chart');

    if (!freqArray || !solver || solver.remainingCount === 0) {
        el.innerHTML = '';
        return;
    }

    const total = solver.remainingCount;

    // Build and sort entries by frequency
    const entries = Array.from({ length: 26 }, (_, c) => ({
        letter: String.fromCharCode(97 + c),
        pct:    Math.round(100 * freqArray[c] / total),
        count:  freqArray[c],
    }))
    .filter(e => e.count > 0)
    .sort((a, b) => b.count - a.count);

    let html = '';
    for (const { letter, pct } of entries) {
        const tier = pct >= 65 ? 'tier-high' : pct >= 35 ? 'tier-mid' : 'tier-low';
        html += `
        <div class="freq-row">
            <span class="freq-letter">${letter}</span>
            <div class="freq-track">
                <div class="freq-bar ${tier}" style="width:${pct}%"></div>
            </div>
            <span class="freq-pct">${pct}%</span>
        </div>`;
    }

    el.innerHTML = html;
}

// Render: Guess Grid
function renderGrid() {
    const grid = document.getElementById('guess-grid');
    grid.innerHTML = '';

    for (let row = 0; row < MAX_GUESSES; row++) {
        const rowEl = document.createElement('div');
        rowEl.className = 'grid-row';
        const guess = state.guessHistory[row];
        const isNew = row === state.guessHistory.length - 1;

        for (let col = 0; col <5; col++) {
            const tile = document.createElement('div');
            tile.className = 'tile';

            if (guess) {
                const letter = guess.word[col];
                const color = resultToClass(guess.result[col]);
                tile.textContent = letter.toUpperCase();

                if (isNew) {
                    // Stagger the flip animation for newly-submitted row
                    tile.style.animationDelay = `${col * 80}ms`;
                    tile.classList.add('flip');
                    // Apply color class after flip reaches midpoint
                    setTimeout(() => tile.classList.add(color), col * 80 + 200);
                } else {
                    tile.classList.add(color);
                }

            }

            rowEl.appendChild(tile);
        }

        grid.appendChild(rowEl);
    }
}

function resultToClass(r) {
    return r === 'G' ? 'green' : r === 'Y' ? 'yellow' : 'gray';
}

// Render: Keyboard
function buildKeyboard() {
    KEYBOARD_ROWS.forEach((row, i) => {
        const rowEl = document.getElementById(`kr-${i}`);
        rowEl.innerHTML = '';
        for (const letter of row) {
            const key = document.createElement('div');
            key.className   = 'key';
            key.textContent = letter.toUpperCase();
            key.id          = `key-${letter}`;
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
    const label = document.getElementById('remaining-label');
    const pill  = document.getElementById('mode-pill');
 
    if (!solver) {
        label.textContent   = 'Loading word list…';
        pill.textContent    = '';
        pill.className      = 'pill loading';
        return;
    }
 
    const n     = solver.remainingCount;
    const total = solver.totalWords;
    label.innerHTML = `<strong>${n.toLocaleString()}</strong> / ${total.toLocaleString()} candidates remaining`;
 
    const mode    = solver.scoringMode;
    pill.textContent = mode === 'entropy' ? '🧮 Entropy' : '📈 Frequency';
    pill.className   = `pill ${mode}`;
 
    document.getElementById('header-mode').textContent = mode === 'entropy' ? 'entropy mode' : 'frequency mode';
}

function updateScoringPill() {
    if (!solver) return;
    const mode = solver.scoringMode;
    const pill = document.getElementById('scoring-pill');
    pill.textContent = mode === 'entropy' ? '🧮 Entropy' : '📈 Frequency';
    pill.className = `pill pill-sm ${mode}`;
}

// Solved Overlay
function showSolvedOverlay(guessCount) {
    const overlay = document.getElementById('solved-overlay');
    document.getElementById('solved-sub').textContent =
        `Solved in ${guessCount} guess${guessCount === 1 ? '' : 'es'} 🎯`;
    overlay.classList.remove('hidden');
}

// Error Display
function showError(html) {
    document.getElementById('rec-body').innerHTML = `
        <div class="spinner-wrap" style="flex-direction:column;gap:0.75rem;padding:2rem 1.5rem;text-align:center;color:#e57373;line-height:1.6">
            ${html}
        </div>`;
}

// Reset
function resetGame() {
    if (!words.length) return;

    solver = new WordleSolver(words);

    state.guessHistory  = [];
    state.currentWord   = '';
    state.currentColors = Array(5).fill('X');
    state.solved        = false;
    state.isComputing   = false;

    document.getElementById('guess-input').value = '';
    document.getElementById('solved-overlay').classList.add('hidden');

    updateColorTileLetters();
    updateSubmitButton();
    renderGrid();
    buildKeyboard();
    updateStatus();
    computeAndRender();
}

// Bootstrap
document.addEventListener('DOMContentLoaded', init);
