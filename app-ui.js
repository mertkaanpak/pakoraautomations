/* ==========================================================
   Pakora UI — Toasts & Bestätigungs-Modal
   Zentrale, wiederverwendbare Dialoge (ersetzen alert/confirm)
   Wird auf allen Seiten geladen.
   ========================================================== */
(function () {
    'use strict';

    function host() {
        let h = document.getElementById('pkToastHost');
        if (!h) {
            h = document.createElement('div');
            h.id = 'pkToastHost';
            h.className = 'pk-toast-host';
            (document.body || document.documentElement).appendChild(h);
        }
        return h;
    }

    const ICONS = { success: '✓', error: '✕', warning: '!', info: 'i' };

    // showToast(nachricht, typ) — typ: 'success' | 'error' | 'warning' | 'info'
    window.showToast = function (msg, type) {
        type = ICONS[type] ? type : 'info';
        const h = host();
        const t = document.createElement('div');
        t.className = 'pk-toast pk-toast-' + type;
        const ic = document.createElement('span');
        ic.className = 'pk-toast-icon';
        ic.textContent = ICONS[type];
        const tx = document.createElement('span');
        tx.className = 'pk-toast-msg';
        tx.textContent = String(msg == null ? '' : msg);
        t.appendChild(ic); t.appendChild(tx);
        h.appendChild(t);
        requestAnimationFrame(() => t.classList.add('pk-in'));
        const dur = type === 'error' ? 5200 : 3400;
        const close = () => { t.classList.remove('pk-in'); setTimeout(() => t.remove(), 260); };
        t.addEventListener('click', close);
        setTimeout(close, dur);
        return t;
    };

    // confirmDialog(nachricht, opts) -> Promise<boolean>
    // opts: { title, okText, cancelText, danger }
    window.confirmDialog = function (message, opts) {
        opts = opts || {};
        return new Promise((resolve) => {
            const ov = document.createElement('div');
            ov.className = 'pk-modal-ov';

            const box = document.createElement('div');
            box.className = 'pk-modal';

            const h3 = document.createElement('div');
            h3.className = 'pk-modal-title';
            h3.textContent = opts.title || 'Bitte bestätigen';

            const p = document.createElement('div');
            p.className = 'pk-modal-msg';
            p.textContent = String(message == null ? '' : message);

            const row = document.createElement('div');
            row.className = 'pk-modal-actions';

            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'pk-btn pk-btn-ghost';
            cancel.textContent = opts.cancelText || 'Abbrechen';

            const ok = document.createElement('button');
            ok.type = 'button';
            ok.className = 'pk-btn ' + (opts.danger ? 'pk-btn-danger' : 'pk-btn-primary');
            ok.textContent = opts.okText || (opts.danger ? 'Löschen' : 'OK');

            row.appendChild(cancel); row.appendChild(ok);
            box.appendChild(h3); box.appendChild(p); box.appendChild(row);
            ov.appendChild(box);
            (document.body || document.documentElement).appendChild(ov);
            requestAnimationFrame(() => ov.classList.add('pk-in'));

            let done = false;
            const finish = (val) => {
                if (done) return; done = true;
                ov.classList.remove('pk-in');
                document.removeEventListener('keydown', onKey);
                setTimeout(() => ov.remove(), 200);
                resolve(val);
            };
            const onKey = (e) => {
                if (e.key === 'Escape') finish(false);
                if (e.key === 'Enter') finish(true);
            };
            cancel.addEventListener('click', () => finish(false));
            ok.addEventListener('click', () => finish(true));
            ov.addEventListener('click', (e) => { if (e.target === ov) finish(false); });
            document.addEventListener('keydown', onKey);
            setTimeout(() => ok.focus(), 60);
        });
    };
})();
