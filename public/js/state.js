export const AppState = {
    activeRoom: null,
    micMuted: false,
    camMuted: false,
    screenSharingActive: false,
    preWarmedTracks: [],
    
    pinnedTileId: null,
    activeSpeakerIdentity: null,
    activeScreenShareTileId: null,
    currentCameraDeviceId: null,

    // FEATURE 1: State Tracking
    handRaised: false
};

export const videoCaptureProfile = {
    resolution: {
        width: { ideal: 2560, max: 2560 },
        height: { ideal: 1440, max: 1440 },
        frameRate: { ideal: 30, max: 30 }
    }
};
