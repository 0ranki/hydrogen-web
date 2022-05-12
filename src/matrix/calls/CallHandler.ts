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

import {ObservableMap} from "../../observable/map/ObservableMap";
import {WebRTC, PeerConnection} from "../../platform/types/WebRTC";
import {MediaDevices, Track} from "../../platform/types/MediaDevices";
import {handlesEventType} from "./PeerCall";
import {EventType, CallIntent} from "./callEventTypes";
import {GroupCall} from "./group/GroupCall";
import {makeId} from "../common";
import {CALL_LOG_TYPE} from "./common";

import type {LocalMedia} from "./LocalMedia";
import type {Room} from "../room/Room";
import type {MemberChange} from "../room/members/RoomMember";
import type {StateEvent} from "../storage/types";
import type {ILogItem, ILogger} from "../../logging/types";
import type {Platform} from "../../platform/web/Platform";
import type {BaseObservableMap} from "../../observable/map/BaseObservableMap";
import type {SignallingMessage, MGroupCallBase} from "./callEventTypes";
import type {Options as GroupCallOptions} from "./group/GroupCall";
import type {Transaction} from "../storage/idb/Transaction";
import type {CallEntry} from "../storage/idb/stores/CallStore";
import type {Clock} from "../../platform/web/dom/Clock";
import type {RoomStateHandler} from "../room/common";

export type Options = Omit<GroupCallOptions, "emitUpdate" | "createTimeout"> & {
    clock: Clock
};

function getRoomMemberKey(roomId: string, userId: string): string {
    return JSON.stringify(roomId)+`,`+JSON.stringify(userId);
}

export class CallHandler implements RoomStateHandler {
    // group calls by call id
    private readonly _calls: ObservableMap<string, GroupCall> = new ObservableMap<string, GroupCall>();
    // map of `"roomId","userId"` to set of conf_id's they are in
    private roomMemberToCallIds: Map<string, Set<string>> = new Map();
    private groupCallOptions: GroupCallOptions;
    private sessionId = makeId("s");

    constructor(private readonly options: Options) {
        this.groupCallOptions = Object.assign({}, this.options, {
            emitUpdate: (groupCall, params) => this._calls.update(groupCall.id, params),
            createTimeout: this.options.clock.createTimeout,
            sessionId: this.sessionId
        });
    }

    async loadCalls(intent: CallIntent = CallIntent.Ring) {
        const txn = await this._getLoadTxn();
        const callEntries = await txn.calls.getByIntent(intent);
        this._loadCallEntries(callEntries, txn);
    }

    async loadCallsForRoom(intent: CallIntent, roomId: string) {
        const txn = await this._getLoadTxn();
        const callEntries = await txn.calls.getByIntentAndRoom(intent, roomId);
        this._loadCallEntries(callEntries, txn);
    }

    private async _getLoadTxn(): Promise<Transaction> {
        const names = this.options.storage.storeNames;
        const txn = await this.options.storage.readTxn([
            names.calls,
            names.roomState
        ]);
        return txn;
    }

    private async _loadCallEntries(callEntries: CallEntry[], txn: Transaction): Promise<void> {
        return this.options.logger.run({l: "loading calls", t: CALL_LOG_TYPE}, async log => {
            log.set("entries", callEntries.length);
            await Promise.all(callEntries.map(async callEntry => {
                if (this._calls.get(callEntry.callId)) {
                    return;
                }
                const event = await txn.roomState.get(callEntry.roomId, EventType.GroupCall, callEntry.callId);
                if (event) {
                    const call = new GroupCall(event.event.state_key, false, event.event.content, event.roomId, this.groupCallOptions);
                    this._calls.set(call.id, call);
                }
            }));
            const roomIds = Array.from(new Set(callEntries.map(e => e.roomId)));
            await Promise.all(roomIds.map(async roomId => {
                // const ownCallsMemberEvent = await txn.roomState.get(roomId, EventType.GroupCallMember, this.options.ownUserId);
                // if (ownCallsMemberEvent) {
                //     this.handleCallMemberEvent(ownCallsMemberEvent.event, log);
                // }
                const callsMemberEvents = await txn.roomState.getAllForType(roomId, EventType.GroupCallMember);
                for (const entry of callsMemberEvents) {
                    this.handleCallMemberEvent(entry.event, roomId, log);
                }
                // TODO: we should be loading the other members as well at some point
            }));
            log.set("newSize", this._calls.size);
        });
    }

    async createCall(roomId: string, type: "m.video" | "m.voice", name: string, intent: CallIntent = CallIntent.Ring): Promise<GroupCall> {
        const call = new GroupCall(makeId("conf-"), true, { 
            "m.name": name,
            "m.intent": intent
        }, roomId, this.groupCallOptions);
        this._calls.set(call.id, call);

        try {
            await call.create(type);
            // store call info so it will ring again when reopening the app
            const txn = await this.options.storage.readWriteTxn([this.options.storage.storeNames.calls]);
            txn.calls.add({
                intent: call.intent,
                callId: call.id,
                timestamp: this.options.clock.now(),
                roomId: roomId
            });
            await txn.complete();
        } catch (err) {
            //if (err.name === "ConnectionError") {
                // if we're offline, give up and remove the call again
                this._calls.remove(call.id);
            //}
            throw err;
        }
        return call;
    }

    get calls(): BaseObservableMap<string, GroupCall> { return this._calls; }

    // TODO: check and poll turn server credentials here

    /** @internal */
    handleRoomState(room: Room, event: StateEvent, txn: Transaction, log: ILogItem) {
        if (event.type === EventType.GroupCall) {
            this.handleCallEvent(event, room.id, txn, log);
        }
        if (event.type === EventType.GroupCallMember) {
            this.handleCallMemberEvent(event, room.id, log);
        }
    }

    /** @internal */
    updateRoomMembers(room: Room, memberChanges: Map<string, MemberChange>) {
        // TODO: also have map for roomId to calls, so we can easily update members
        // we will also need this to get the call for a room
    }

    /** @internal */
    handlesDeviceMessageEventType(eventType: string): boolean {
        return handlesEventType(eventType);
    }

    /** @internal */
    handleDeviceMessage(message: SignallingMessage<MGroupCallBase>, userId: string, deviceId: string, log: ILogItem) {
        // TODO: buffer messages for calls we haven't received the state event for yet?
        const call = this._calls.get(message.content.conf_id);
        call?.handleDeviceMessage(message, userId, deviceId, log);
    }

    private handleCallEvent(event: StateEvent, roomId: string, txn: Transaction, log: ILogItem) {
        const callId = event.state_key;
        let call = this._calls.get(callId);
        if (call) {
            call.updateCallEvent(event.content, log);
            if (call.isTerminated) {
                call.disconnect(log);
                this._calls.remove(call.id);
                txn.calls.remove(call.intent, roomId, call.id);
            }
        } else {
            call = new GroupCall(event.state_key, false, event.content, roomId, this.groupCallOptions);
            this._calls.set(call.id, call);
            txn.calls.add({
                intent: call.intent,
                callId: call.id,
                timestamp: event.origin_server_ts,
                roomId: roomId
            });
        }
    }

    private handleCallMemberEvent(event: StateEvent, roomId: string, log: ILogItem) {
        const userId = event.state_key;
        const roomMemberKey = getRoomMemberKey(roomId, userId)
        const calls = event.content["m.calls"] ?? [];
        for (const call of calls) {
            const callId = call["m.call_id"];
            const groupCall = this._calls.get(callId);
            // TODO: also check the member when receiving the m.call event
            groupCall?.updateMembership(userId, call, log);
        };
        const newCallIdsMemberOf = new Set<string>(calls.map(call => call["m.call_id"]));
        let previousCallIdsMemberOf = this.roomMemberToCallIds.get(roomMemberKey);

        // remove user as member of any calls not present anymore
        if (previousCallIdsMemberOf) {
            for (const previousCallId of previousCallIdsMemberOf) {
                if (!newCallIdsMemberOf.has(previousCallId)) {
                    const groupCall = this._calls.get(previousCallId);
                    groupCall?.removeMembership(userId, log);
                }
            }
        }
        if (newCallIdsMemberOf.size === 0) {
            this.roomMemberToCallIds.delete(roomMemberKey);
        } else {
            this.roomMemberToCallIds.set(roomMemberKey, newCallIdsMemberOf);
        }
    }
}

