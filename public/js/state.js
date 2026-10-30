export const isIOS = () => {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || 
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
};

export function getResolutionProfile(deviceLabel = '') {
    const label = deviceLabel.toLowerCase();
    const isFront = label.includes('front') || label.includes('vorder') || label.includes('facetime');

    // iOS Front Camera: Standard 1080p maintains hardware ISP binned pipeline for Portrait Mode
    if (isIOS() && (isFront || label === '')) {
        return {
            width: { ideal: 1920, max: 1920 },
            height: { ideal: 1080, max: 1080 },
            frameRate: { ideal: 30, max: 30 }
        };
    }

    // Desktops, rear lenses, and external USB webcams (Logitech Brio, Elgato Cam Link, etc.)
    // Capped at 720p30: simulcast software-encodes up to three layers from this source, and a
    // 1440p source costs roughly 4x the CPU of 720p while tiles rarely display that many pixels.
    return {
        width: { ideal: 1280, max: 1280 },
        height: { ideal: 720, max: 720 },
        frameRate: { ideal: 30, max: 30 }
    };
}

export const AppState = {
    activeRoom: null,
    preWarmedTracks: [],
    pinnedTileId: null,
    // Grid tiles made larger by dragging their corner: tile id -> cells per side (2 or 3)
    tileSpans: new Map(),
    activeScreenShareTileId: null,
    activeSpeakerIdentity: null,
    micMuted: false,
    camMuted: false,
    handRaised: false,
    screenSharingActive: false,
    currentCameraDeviceId: null,
    participantPreferences: new Map(),
    localPreferredCodec: 'h264',
    currentPublishedCodec: 'h264',
    isRenegotiating: false,
    // Sharing: the joined room, its password when protected (goes into invite links),
    // and the audience id for listen-only links.
    roomName: '',
    roomPassword: '',
    audienceId: null,
    audienceMode: false,
    // Chat and files vanish after 1 / 10 minutes; otherwise they stay until everyone has left
    chatDisappearing: false
};

export const videoCaptureProfile = {
    resolution: getResolutionProfile()
};
