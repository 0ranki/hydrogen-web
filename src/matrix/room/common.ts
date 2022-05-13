/*
Copyright 2020 The Matrix.org Foundation C.I.C.

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

import type {Room} from "./Room";
import type {StateEvent, TimelineEvent} from "../storage/types";
import type {Transaction} from "../storage/idb/Transaction";
import type {ILogItem} from "../../logging/types";
import type {MemberChange} from "./members/RoomMember";

export function getPrevContentFromStateEvent(event) {
    // where to look for prev_content is a bit of a mess,
    // see https://matrix.to/#/!NasysSDfxKxZBzJJoE:matrix.org/$DvrAbZJiILkOmOIuRsNoHmh2v7UO5CWp_rYhlGk34fQ?via=matrix.org&via=pixie.town&via=amorgan.xyz
    return event.unsigned?.prev_content || event.prev_content;
}

export const REDACTION_TYPE = "m.room.redaction";

export function isRedacted(event) {
    return !!event?.unsigned?.redacted_because;
}

export enum RoomStatus {
    None = 1 << 0,
    BeingCreated = 1 << 1,
    Invited = 1 << 2,
    Joined = 1 << 3,
    Replaced = 1 << 4,
    Archived = 1 << 5,
}

export enum RoomVisibility {
    DirectMessage,
    Private,
    Public,
}

export enum RoomType {
    World
}

type RoomResponse = {
    state?: {
        events?: Array<StateEvent>
    },
    timeline?: {
        events?: Array<StateEvent>
    }
}

/** iterates over any state events in a sync room response, in the order that they should be applied (from older to younger events) */
export function iterateResponseStateEvents(roomResponse: RoomResponse, callback: (StateEvent) => void) {
    // first iterate over state events, they precede the timeline
    const stateEvents = roomResponse.state?.events;
    if (stateEvents) {
        for (let i = 0; i < stateEvents.length; i++) {
            callback(stateEvents[i]);
        }
    }
    // now see if there are any state events within the timeline
    let timelineEvents = roomResponse.timeline?.events;
    if (timelineEvents) {
        for (let i = 0; i < timelineEvents.length; i++) {
            const event = timelineEvents[i];
            if (typeof event.state_key === "string") {
                callback(event);
            }
        }
    }
}

export function tests() {
    return {
        "test iterateResponseStateEvents with both state and timeline sections": assert => {
            const roomResponse = {
                state: {
                    events: [
                        {type: "m.room.member", state_key: "1"},
                        {type: "m.room.member", state_key: "2", content: {a: 1}},
                    ]
                },
                timeline: {
                    events: [
                        {type: "m.room.message"},
                        {type: "m.room.member", state_key: "3"},
                        {type: "m.room.message"},
                        {type: "m.room.member", state_key: "2", content: {a: 2}},
                    ]
                }
            } as unknown as RoomResponse;
            const expectedStateKeys = ["1", "2", "3", "2"];
            const expectedAForMember2 = [1, 2];
            iterateResponseStateEvents(roomResponse, event => {
                assert.strictEqual(event.type, "m.room.member");
                assert.strictEqual(expectedStateKeys.shift(), event.state_key);
                if (event.state_key === "2") {
                    assert.strictEqual(expectedAForMember2.shift(), event.content.a);
                }
            });
            assert.strictEqual(expectedStateKeys.length, 0);
            assert.strictEqual(expectedAForMember2.length, 0);
        },
        "test iterateResponseStateEvents with empty response": assert => {
            iterateResponseStateEvents({}, () => {
                assert.fail("no events expected");
            });
        }
    }
}
