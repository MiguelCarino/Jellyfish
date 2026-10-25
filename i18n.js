// i18n — Jellyfish dictionaries (fleet convention, see Password/i18n.js).
// English source strings ARE the keys, so a missing entry falls back to
// English. Locale comes from carino-lang.js (window.CarinoLang.current);
// this script is deferred and loaded after it, and re-applies on the fleet
// 'carino:langchange' event. The page has very little text: the navbar
// greeting, the three framing buttons, the pause button, the transient key
// hint and the two no-WebGL lines.

const I18N = {
    es: {
        'Late shift.': 'Turno nocturno.',
        'Good morning.': 'Buenos días.',
        'Good afternoon.': 'Buenas tardes.',
        'Good evening.': 'Buenas noches.',
        'More': 'Más',
        'View': 'Vista',
        'Tank': 'Tanque',
        'Alongside': 'Al lado',
        'Close up': 'De cerca',
        'Pause': 'Pausa',
        'Resume': 'Reanudar',
        '1 tank · 2 alongside · 3 close · P pause': '1 tanque · 2 al lado · 3 de cerca · P pausa',
        'This page needs WebGL2, which this browser does not have.': 'Esta página necesita WebGL2 y este navegador no lo tiene.',
        'The renderer could not start on this device.': 'El renderizador no pudo arrancar en este dispositivo.',
    },
    'pt-BR': {
        'Late shift.': 'Turno da noite.',
        'Good morning.': 'Bom dia.',
        'Good afternoon.': 'Boa tarde.',
        'Good evening.': 'Boa noite.',
        'More': 'Mais',
        'View': 'Visão',
        'Tank': 'Tanque',
        'Alongside': 'Ao lado',
        'Close up': 'De perto',
        'Pause': 'Pausar',
        'Resume': 'Retomar',
        '1 tank · 2 alongside · 3 close · P pause': '1 tanque · 2 ao lado · 3 de perto · P pausar',
        'This page needs WebGL2, which this browser does not have.': 'Esta página precisa de WebGL2, que este navegador não tem.',
        'The renderer could not start on this device.': 'O renderizador não conseguiu iniciar neste dispositivo.',
    },
    ja: {
        'Late shift.': '夜勤お疲れさま。',
        'Good morning.': 'おはようございます。',
        'Good afternoon.': 'こんにちは。',
        'Good evening.': 'こんばんは。',
        'More': 'その他',
        'View': '視点',
        'Tank': '水槽',
        'Alongside': '並走',
        'Close up': '接写',
        'Pause': '一時停止',
        'Resume': '再開',
        '1 tank · 2 alongside · 3 close · P pause': '1 水槽 · 2 並走 · 3 接写 · P 一時停止',
        'This page needs WebGL2, which this browser does not have.': 'このページには WebGL2 が必要ですが、このブラウザーは対応していません。',
        'The renderer could not start on this device.': 'この端末では描画を開始できませんでした。',
    },
    ru: {
        'Late shift.': 'Ночная смена.',
        'Good morning.': 'Доброе утро.',
        'Good afternoon.': 'Добрый день.',
        'Good evening.': 'Добрый вечер.',
        'More': 'Ещё',
        'View': 'Вид',
        'Tank': 'Аквариум',
        'Alongside': 'Рядом',
        'Close up': 'Вблизи',
        'Pause': 'Пауза',
        'Resume': 'Продолжить',
        '1 tank · 2 alongside · 3 close · P pause': '1 аквариум · 2 рядом · 3 вблизи · P пауза',
        'This page needs WebGL2, which this browser does not have.': 'Этой странице нужен WebGL2, а в этом браузере его нет.',
        'The renderer could not start on this device.': 'На этом устройстве не удалось запустить отрисовку.',
    },
};

function currentFleetLang() { return (window.CarinoLang && window.CarinoLang.current) || 'en'; }

function t(key) {
    const dict = I18N[currentFleetLang()];
    return (dict && dict[key]) || key;
}

// Static markup: elements carrying data-i18n use their original English text
// as the key (captured on first pass, so locale switches stay reversible).
function applyStaticI18n() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
        if (!el.dataset.i18nKey) el.dataset.i18nKey = el.textContent.trim().replace(/\s+/g, ' ');
        el.textContent = t(el.dataset.i18nKey);
    });
    const seg = document.querySelector('.jf-seg');
    if (seg) seg.setAttribute('aria-label', t('View'));
}

function applyI18n() {
    document.documentElement.lang = currentFleetLang();
    applyStaticI18n();
}

document.addEventListener('DOMContentLoaded', applyI18n);
window.addEventListener('carino:langchange', applyI18n);
