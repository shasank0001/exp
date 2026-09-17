// Interactions scoped to the Thread study. No real files, jobs, or telemetry.
(() => {
  const backdrop = document.querySelector('.panel-backdrop');
  let openPanel = null;
  let previousFocus = null;
  const focusable = 'button:not([disabled]), a[href], textarea, summary, [tabindex="0"]';

  function closePanel() {
    if (!openPanel) return;
    openPanel.classList.remove('panel-open');
    openPanel = null;
    backdrop.hidden = true;
    document.querySelectorAll('.app > *').forEach(el => { el.inert = false; });
    document.querySelectorAll('[data-panel-toggle]').forEach(el => el.setAttribute('aria-expanded', 'false'));
    previousFocus?.focus();
  }

  document.addEventListener('click', event => {
    const toggle = event.target.closest('[data-panel-toggle]');
    if (toggle) {
      const panel = document.getElementById(toggle.dataset.panelToggle);
      const wasOpen = panel === openPanel;
      closePanel();
      if (wasOpen) return;
      previousFocus = toggle;
      openPanel = panel;
      panel.classList.add('panel-open');
      backdrop.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      document.querySelectorAll('.app > *').forEach(el => { el.inert = el !== panel; });
      panel.querySelector('[data-panel-close]').focus();
    } else if (event.target.closest('[data-panel-close]') || event.target === backdrop) {
      closePanel();
    } else if (openPanel && event.target.closest('[data-action],[data-file],[data-sample],.current-thread')) {
      // Restore the workspace before the shared dialog opens and captures focus.
      closePanel();
    }
  }, true);

  document.addEventListener('keydown', event => {
    if (!openPanel || document.querySelector('.modal-shade')) return;
    if (event.key === 'Escape') closePanel();
    if (event.key === 'Tab') {
      const elements = [...openPanel.querySelectorAll(focusable)].filter(el => el.getClientRects().length);
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener('resize', closePanel);
  document.querySelector('.current-thread').addEventListener('click', () => {
    document.querySelector('.conversation-pane').scrollTo({top: 0, behavior: reducedMotion() ? 'instant' : 'smooth'});
  });

  document.querySelector('.memory-bars').innerHTML = Array.from({length: 24}, (_, i) => `<i class="${i < 8 ? 'used' : ''}"></i>`).join('');
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Keep both run controls and all status indicators in sync.
  let paused = false;
  document.addEventListener('click', event => {
    if (!event.target.closest('[data-action="pause"]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    paused = !paused;
    document.querySelectorAll('[data-action="pause"]').forEach(button => {
      button.dataset.paused = String(paused);
      button.innerHTML = icon(paused ? 'play' : 'pause') + (paused ? ' Resume run' : ' Pause run');
    });
    document.querySelectorAll('[data-run-status]').forEach(el => { el.textContent = paused ? 'Paused' : 'Running'; });
    document.querySelectorAll('.run-state').forEach(el => el.classList.toggle('is-paused', paused));
    document.querySelector('[data-eta]').textContent = paused ? 'Paused at epoch 24' : '~44m remaining';
    toast(paused ? 'Preview paused. No real process was affected.' : 'Preview resumed. Telemetry is simulated.');
  }, true);

  function updateComposer(input) {
    input.style.height = '44px';
    input.style.height = Math.min(140, Math.max(44, input.scrollHeight)) + 'px';
    input.form.querySelector('.send').disabled = !input.value.trim();
  }
  document.querySelectorAll('[data-chat] textarea').forEach(updateComposer);
  document.addEventListener('input', event => {
    if (event.target.matches('[data-chat] textarea')) updateComposer(event.target);
  });
  document.addEventListener('click', event => {
    if (event.target.closest('[data-prompt]')) updateComposer(document.querySelector('[data-chat] textarea'));
  });

  // Route modal replies to their own conversation, rather than the background thread.
  document.addEventListener('submit', event => {
    if (!event.target.matches('[data-chat]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const form = event.target;
    const input = form.querySelector('textarea');
    const text = input.value.trim();
    if (!text) return;
    const scope = form.closest('.modal') || document.querySelector('.conversation');
    const target = scope.querySelector('[data-messages]');
    if (!target) return;
    const message = document.createElement('div');
    message.innerHTML = `<article class="chat-message"><span class="avatar user-avatar">SK</span><div class="content"><div class="byline">You <span>just now</span></div><div class="user-bubble"><p>${escapeHTML(text).replace(/\n/g, '<br>')}</p></div></div></article><article class="chat-message"><span class="avatar agent-avatar">m/</span><div class="content"><div class="byline">ML Copilot <span>simulated response</span></div><p>${reply(text)}</p></div></article>`;
    target.append(message);
    input.value = '';
    updateComposer(input);
    message.scrollIntoView({behavior: reducedMotion() ? 'instant' : 'smooth', block: 'end'});
    input.focus({preventScroll: true});
  }, true);
  // Let IME users confirm composed text without sending it prematurely.
  document.addEventListener('keydown', event => {
    if (event.target.matches('[data-chat] textarea') && event.key === 'Enter' && event.isComposing) event.stopImmediatePropagation();
  }, true);
})();
