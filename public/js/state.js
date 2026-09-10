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
    return {
        width: { ideal: 2560 },
        height: { ideal: 1440 },
        frameRate: { ideal: 30 }
    };
}

export const AppState = {
    activeRoom: null,
    preWarmedTracks: [],
    pinnedTileId: null,
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
    isRenegotiating: false
};

export const videoCaptureProfile = {
    resolution: getResolutionProfile()
};
