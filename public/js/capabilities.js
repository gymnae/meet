// === CAPABILITY-BASED CONTROL VISIBILITY ===
// Hides dock buttons for features the current device/browser cannot provide,
// and re-evaluates when devices are hot-plugged or removed. Browsers DO fire
// 'devicechange' on connect/disconnect of cameras and microphones — but only
// after media permission has been granted at least once (before that, the
// device list is privacy-redacted and labels/counts are unreliable).

let bound = false;

export function initCapabilityChecks() {
    if (bound) return;
    bound = true;

    refreshControlVisibility();

    if (navigator.mediaDevices?.addEventListener) {
        navigator.mediaDevices.addEventListener('devicechange', refreshControlVisibility);
    }
    window.addEventListener('resize', refreshControlVisibility);
}

export async function refreshControlVisibility() {
    updateShareButton();
    await updateMediaButtons();
}

// Screen share: getDisplayMedia is absent on iOS Safari entirely; present on
// Android Chrome and all desktop browsers.
function updateShareButton() {
    const btn = document.getElementById('btnScreen');
    if (!btn) return;
    const supported = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
    setVisible(btn, supported);
}

// Mic/Cam: hide only when we can positively determine NO device exists.
// Before permission, enumerateDevices() may return redacted entries — treat
// "unknown" as available so the button (which itself requests access) stays.
async function updateMediaButtons() {
    const micBtn = document.getElementById('btnMic');
    const camBtn = document.getElementById('btnCam');

    if (!navigator.mediaDevices?.enumerateDevices) {
        // Very old engine: keep buttons visible, their own flow shows the error
        return;
    }

    try {
        const devices = await navigator.mediaDevices.enumerateDevices();

        // Zero enumerated devices of a kind == definitively absent.
        // (Browsers still list redacted entries pre-permission, so an empty
        // list here genuinely means no hardware.)
        const hasMic = devices.some(d => d.kind === 'audioinput');
        const hasCam = devices.some(d => d.kind === 'videoinput');
        const enumeratedAny = devices.length > 0;

        if (micBtn) setVisible(micBtn, !enumeratedAny || hasMic);
        if (camBtn) setVisible(camBtn, !enumeratedAny || hasCam);
    } catch (e) {
        // Enumeration failed — leave buttons as-is
    }
}

function setVisible(btn, visible) {
    // display:none frees dock space entirely (vs visibility:hidden)
    btn.style.display = visible ? '' : 'none';
}
