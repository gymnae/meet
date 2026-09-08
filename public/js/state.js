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
    isRenegotiating: false,
    handRaised: false
};

export const videoCaptureProfile = {
    resolution: {
        width: { ideal: 2560, max: 2560 },
        height: { ideal: 1440, max: 1440 },
        frameRate: { ideal: 30, max: 30 }
    }
};
