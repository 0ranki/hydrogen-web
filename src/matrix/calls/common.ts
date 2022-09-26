/*
Copyright 2022 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import type {Track, Stream} from "../../platform/types/MediaDevices";

export function getStreamAudioTrack(stream: Stream | undefined): Track | undefined {
    return stream?.getAudioTracks()[0];
}

export function getStreamVideoTrack(stream: Stream | undefined): Track | undefined {
    return stream?.getVideoTracks()[0];
}

export class MuteSettings {
    constructor (
        private readonly isMicrophoneMuted: boolean = false,
        private readonly isCameraMuted: boolean = false,
        private hasMicrophoneTrack: boolean = false,
        private hasCameraTrack: boolean = false,
    ) {}

    updateTrackInfo(userMedia: Stream | undefined) {
        this.hasMicrophoneTrack = !!getStreamAudioTrack(userMedia);
        this.hasCameraTrack = !!getStreamVideoTrack(userMedia);
    }

    get microphone(): boolean {
        return !this.hasMicrophoneTrack || this.isMicrophoneMuted;
    }

    get camera(): boolean {
        return !this.hasCameraTrack || this.isCameraMuted;
    }

    toggleCamera(): MuteSettings {
        return new MuteSettings(this.microphone, !this.camera, this.hasMicrophoneTrack, this.hasCameraTrack);
    }

    toggleMicrophone(): MuteSettings {
        return new MuteSettings(!this.microphone, this.camera, this.hasMicrophoneTrack, this.hasCameraTrack);
    }

    equals(other: MuteSettings) {
        return this.microphone === other.microphone && this.camera === other.camera;
    }
}

export const CALL_LOG_TYPE = "call";
//export const CALL_MEMBER_VALIDITY_PERIOD_MS = 3600 * 1000; // 1h
export const CALL_MEMBER_VALIDITY_PERIOD_MS = 60 * 1000;
