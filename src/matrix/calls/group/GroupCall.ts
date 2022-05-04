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

import {ObservableMap} from "../../../observable/map/ObservableMap";
import {Member} from "./Member";
import {LocalMedia} from "../LocalMedia";
import {MuteSettings, CALL_LOG_TYPE} from "../common";
import {RoomMember} from "../../room/members/RoomMember";
import {EventEmitter} from "../../../utils/EventEmitter";
import {EventType, CallIntent} from "../callEventTypes";

import type {Options as MemberOptions} from "./Member";
import type {BaseObservableMap} from "../../../observable/map/BaseObservableMap";
import type {Track} from "../../../platform/types/MediaDevices";
import type {SignallingMessage, MGroupCallBase, CallMembership} from "../callEventTypes";
import type {Room} from "../../room/Room";
import type {StateEvent} from "../../storage/types";
import type {Platform} from "../../../platform/web/Platform";
import type {EncryptedMessage} from "../../e2ee/olm/Encryption";
import type {ILogItem, ILogger} from "../../../logging/types";
import type {Storage} from "../../storage/idb/Storage";

export enum GroupCallState {
    Fledgling = "fledgling",
    Creating = "creating",
    Created = "created",
    Joining = "joining",
    Joined = "joined",
}

function getMemberKey(userId: string, deviceId: string) {
    return JSON.stringify(userId)+`,`+JSON.stringify(deviceId);
}

function memberKeyIsForUser(key: string, userId: string) {
    return key.startsWith(JSON.stringify(userId)+`,`);
}

function getDeviceFromMemberKey(key: string): string {
    return JSON.parse(`[${key}]`)[1];
}

export type Options = Omit<MemberOptions, "emitUpdate" | "confId" | "encryptDeviceMessage"> & {
    emitUpdate: (call: GroupCall, params?: any) => void;
    encryptDeviceMessage: (roomId: string, userId: string, message: SignallingMessage<MGroupCallBase>, log: ILogItem) => Promise<EncryptedMessage>,
    storage: Storage,
    logger: ILogger,
};

class JoinedData {
    constructor(
        public readonly logItem: ILogItem,
        public readonly membersLogItem: ILogItem,
        public localMedia: LocalMedia,
        public localMuteSettings: MuteSettings
    ) {}

    dispose() {
        this.localMedia.dispose();
        this.logItem.finish();
    }
}

export class GroupCall extends EventEmitter<{change: never}> {
    private readonly _members: ObservableMap<string, Member> = new ObservableMap();
    private _memberOptions: MemberOptions;
    private _state: GroupCallState;
    private bufferedDeviceMessages = new Map<string, Set<SignallingMessage<MGroupCallBase>>>();
    private joinedData?: JoinedData;

    constructor(
        public readonly id: string,
        newCall: boolean,
        private callContent: Record<string, any>,
        public readonly roomId: string,
        private readonly options: Options,
    ) {
        super();
        this._state = newCall ? GroupCallState.Fledgling : GroupCallState.Created;
        this._memberOptions = Object.assign({}, options, {
            confId: this.id,
            emitUpdate: member => this._members.update(getMemberKey(member.userId, member.deviceId), member),
            encryptDeviceMessage: (userId: string, message: SignallingMessage<MGroupCallBase>, log) => {
                return this.options.encryptDeviceMessage(this.roomId, userId, message, log);
            }
        });
    }

    get localMedia(): LocalMedia | undefined { return this.joinedData?.localMedia; }
    get members(): BaseObservableMap<string, Member> { return this._members; }

    get isTerminated(): boolean {
        return this.callContent?.["m.terminated"] === true;
    }

    get isRinging(): boolean {
        return this._state === GroupCallState.Created && this.intent === "m.ring" && !this.isMember(this.options.ownUserId);
    }

    get name(): string {
        return this.callContent?.["m.name"];
    }

    get intent(): CallIntent {
        return this.callContent?.["m.intent"];
    }

    async join(localMedia: LocalMedia): Promise<void> {
        if (this._state !== GroupCallState.Created || this.joinedData) {
            return;
        }
        const logItem = this.options.logger.child({
            l: "answer call",
            t: CALL_LOG_TYPE,
            id: this.id,
            ownSessionId: this.options.sessionId
        });
        const membersLogItem = logItem.child("member connections");
        const joinedData = new JoinedData(
            logItem,
            membersLogItem,
            localMedia,
            new MuteSettings()
        );
        this.joinedData = joinedData;
        await joinedData.logItem.wrap("join", async log => {
            this._state = GroupCallState.Joining;
            this.emitChange();
            const memberContent = await this._createJoinPayload();
            // send m.call.member state event
            const request = this.options.hsApi.sendState(this.roomId, EventType.GroupCallMember, this.options.ownUserId, memberContent, {log});
            await request.response();
            this.emitChange();
            // send invite to all members that are < my userId
            for (const [,member] of this._members) {
                this.connectToMember(member, joinedData, log);
            }
        });
    }

    async setMedia(localMedia: LocalMedia): Promise<void> {
        if ((this._state === GroupCallState.Joining || this._state === GroupCallState.Joined) && this.joinedData) {
            const oldMedia = this.joinedData.localMedia;
            this.joinedData.localMedia = localMedia;
            await Promise.all(Array.from(this._members.values()).map(m => {
                return m.setMedia(localMedia, oldMedia);
            }));
            oldMedia?.stopExcept(localMedia);
        }
    }

    async setMuted(muteSettings: MuteSettings): Promise<void> {
        const {joinedData} = this;
        if (!joinedData) {
            return;
        }
        joinedData.localMuteSettings = muteSettings;
        await Promise.all(Array.from(this._members.values()).map(m => {
            return m.setMuted(joinedData.localMuteSettings);
        }));
        this.emitChange();
    }

    get muteSettings(): MuteSettings | undefined {
        return this.joinedData?.localMuteSettings;
    }

    get hasJoined() {
        return this._state === GroupCallState.Joining || this._state === GroupCallState.Joined;
    }

    async leave(): Promise<void> {
        const {joinedData} = this;
        if (!joinedData) {
            return;
        }
        await joinedData.logItem.wrap("leave", async log => {
            try {
                const memberContent = await this._leaveCallMemberContent();
                // send m.call.member state event
                if (memberContent) {
                    const request = this.options.hsApi.sendState(this.roomId, EventType.GroupCallMember, this.options.ownUserId, memberContent, {log});
                    await request.response();
                    // our own user isn't included in members, so not in the count
                    if (this.intent === CallIntent.Ring && this._members.size === 0) {
                        await this.terminate(log);
                    }
                } else {
                    log.set("already_left", true);
                }
            } finally {
                this.disconnect(log);
            }
        });
    }

    terminate(log?: ILogItem): Promise<void> {
        return this.options.logger.wrapOrRun(log, {l: "terminate call", t: CALL_LOG_TYPE}, async log => {
            if (this._state === GroupCallState.Fledgling) {
                return;
            }
            const request = this.options.hsApi.sendState(this.roomId, EventType.GroupCall, this.id, Object.assign({}, this.callContent, {
                "m.terminated": true
            }), {log});
            await request.response();
        });
    }

    /** @internal */
    create(type: "m.video" | "m.voice", log?: ILogItem): Promise<void> {
        return this.options.logger.wrapOrRun(log, {l: "create call", t: CALL_LOG_TYPE}, async log => {
            if (this._state !== GroupCallState.Fledgling) {
                return;
            }
            this._state = GroupCallState.Creating;
            this.emitChange();
            this.callContent = Object.assign({
                "m.type": type,
            }, this.callContent);
            const request = this.options.hsApi.sendState(this.roomId, EventType.GroupCall, this.id, this.callContent!, {log});
            await request.response();
            this._state = GroupCallState.Created;
            this.emitChange();
        });
    }

    /** @internal */
    updateCallEvent(callContent: Record<string, any>, syncLog: ILogItem) {
        syncLog.wrap({l: "update call", t: CALL_LOG_TYPE}, log => {
            log.set("id", this.id);
            this.callContent = callContent;
            if (this._state === GroupCallState.Creating) {
                this._state = GroupCallState.Created;
            }
            log.set("status", this._state);
            this.emitChange();
        });
    }

    /** @internal */
    updateMembership(userId: string, callMembership: CallMembership, syncLog: ILogItem) {
        syncLog.wrap({l: "update call membership", t: CALL_LOG_TYPE, id: this.id, userId}, log => {
            const devices = callMembership["m.devices"];
            const previousDeviceIds = this.getDeviceIdsForUserId(userId);
            for (const device of devices) {
                const deviceId = device.device_id;
                const memberKey = getMemberKey(userId, deviceId);
                log.wrap({l: "update device membership", id: memberKey, sessionId: device.session_id}, log => {
                    if (userId === this.options.ownUserId && deviceId === this.options.ownDeviceId) {
                        if (this._state === GroupCallState.Joining) {
                            log.set("update_own", true);
                            this._state = GroupCallState.Joined;
                            this.emitChange();
                        }
                    } else {
                        let member = this._members.get(memberKey);
                        const sessionIdChanged = member && member.sessionId !== device.session_id;
                        if (member && !sessionIdChanged) {
                            log.set("update", true);
                            member.updateCallInfo(device, log);
                        } else {
                            if (member && sessionIdChanged) {
                                log.set("removedSessionId", member.sessionId);
                                member.disconnect(false, log);
                                this._members.remove(memberKey);
                                member = undefined;
                            }
                            log.set("add", true);
                            member = new Member(
                                RoomMember.fromUserId(this.roomId, userId, "join"),
                                device, this._memberOptions,
                            );
                            this._members.add(memberKey, member);
                            if (this.joinedData) {
                                this.connectToMember(member, this.joinedData, log);
                            }
                        }
                        // flush pending messages, either after having created the member,
                        // or updated the session id with updateCallInfo
                        this.flushPendingIncomingDeviceMessages(member, log);
                    }
                });
            }

            const newDeviceIds = new Set<string>(devices.map(call => call.device_id));
            // remove user as member of any calls not present anymore
            for (const previousDeviceId of previousDeviceIds) {
                if (!newDeviceIds.has(previousDeviceId)) {
                    log.wrap({l: "remove device member", id: getMemberKey(userId, previousDeviceId)}, log => {
                        this.removeMemberDevice(userId, previousDeviceId, log);
                    });
                }
            }
            if (userId === this.options.ownUserId && !newDeviceIds.has(this.options.ownDeviceId)) {
                this.removeOwnDevice(log);
            }
        });
    }

    /** @internal */
    removeMembership(userId: string, syncLog: ILogItem) {
        const deviceIds = this.getDeviceIdsForUserId(userId);
        syncLog.wrap({
            l: "remove call member",
            t: CALL_LOG_TYPE,
            id: this.id
        }, log => {
            for (const deviceId of deviceIds) {
                this.removeMemberDevice(userId, deviceId, log);
            }
            if (userId === this.options.ownUserId) {
                this.removeOwnDevice(log);
            }
        });
    }

    private flushPendingIncomingDeviceMessages(member: Member, log: ILogItem) {
        const memberKey = getMemberKey(member.userId, member.deviceId);
        const bufferedMessages = this.bufferedDeviceMessages.get(memberKey);
        // check if we have any pending message for the member with (userid, deviceid, sessionid)
        if (bufferedMessages) {
            for (const message of bufferedMessages) {
                if (message.content.sender_session_id === member.sessionId) {
                    member.handleDeviceMessage(message, log);
                    bufferedMessages.delete(message);
                }
            }
            if (bufferedMessages.size === 0) {
                this.bufferedDeviceMessages.delete(memberKey);
            }
        }
    }

    private getDeviceIdsForUserId(userId: string): string[] {
        return Array.from(this._members.keys())
            .filter(key => memberKeyIsForUser(key, userId))
            .map(key => getDeviceFromMemberKey(key));
    }

    private isMember(userId: string): boolean {
        return Array.from(this._members.keys()).some(key => memberKeyIsForUser(key, userId));
    }

    private removeOwnDevice(log: ILogItem) {
        log.set("leave_own", true);
        this.disconnect(log);
    }

    /** @internal */
    disconnect(log: ILogItem) {
        if (this._state === GroupCallState.Joined) {
            for (const [,member] of this._members) {
                member.disconnect(true, log);
            }
            this._state = GroupCallState.Created;
        }
        this.joinedData?.dispose();
        this.joinedData = undefined;
        this.emitChange();
    }

    /** @internal */
    private removeMemberDevice(userId: string, deviceId: string, log: ILogItem) {
        const memberKey = getMemberKey(userId, deviceId);
        log.set("id", memberKey);
        const member = this._members.get(memberKey);
        if (member) {
            log.set("leave", true);
            this._members.remove(memberKey);
            member.disconnect(false, log);
        }
        this.emitChange();
    }

    /** @internal */
    handleDeviceMessage(message: SignallingMessage<MGroupCallBase>, userId: string, deviceId: string, syncLog: ILogItem) {
        // TODO: return if we are not membering to the call
        const key = getMemberKey(userId, deviceId);
        let member = this._members.get(key);
        if (member && message.content.sender_session_id === member.sessionId) {
            member.handleDeviceMessage(message, syncLog);
        } else {
            const item = syncLog.log({
                l: "call: buffering to_device message, member not found",
                t: CALL_LOG_TYPE,
                id: this.id,
                userId,
                deviceId,
                sessionId: message.content.sender_session_id,
                type: message.type
            });
            syncLog.refDetached(item);
            // we haven't received the m.call.member yet for this caller (or with this session id).
            // buffer the device messages or create the member/call as it should arrive in a moment
            let messages = this.bufferedDeviceMessages.get(key);
            if (!messages) {
                messages = new Set();
                this.bufferedDeviceMessages.set(key, messages);
            }
            messages.add(message);
        }
    }

    private async _createJoinPayload() {
        const {storage} = this.options;
        const txn = await storage.readTxn([storage.storeNames.roomState]);
        const stateEvent = await txn.roomState.get(this.roomId, EventType.GroupCallMember, this.options.ownUserId);
        const stateContent = stateEvent?.event?.content ?? {
            ["m.calls"]: []
        };
        const callsInfo = stateContent["m.calls"];
        let callInfo = callsInfo.find(c => c["m.call_id"] === this.id);
        if (!callInfo) {
            callInfo = {
                ["m.call_id"]: this.id,
                ["m.devices"]: []
            };
            callsInfo.push(callInfo);
        }
        callInfo["m.devices"] = callInfo["m.devices"].filter(d => d["device_id"] !== this.options.ownDeviceId);
        callInfo["m.devices"].push({
            ["device_id"]: this.options.ownDeviceId,
            ["session_id"]: this.options.sessionId,
            feeds: [{purpose: "m.usermedia"}]
        });
        return stateContent;
    }

    private async _leaveCallMemberContent(): Promise<Record<string, any> | undefined> {
        const {storage} = this.options;
        const txn = await storage.readTxn([storage.storeNames.roomState]);
        const stateEvent = await txn.roomState.get(this.roomId, EventType.GroupCallMember, this.options.ownUserId);
        if (stateEvent) {
            const content = stateEvent.event.content;
            const callInfo = content["m.calls"]?.find(c => c["m.call_id"] === this.id);
            if (callInfo) {
                const devicesInfo = callInfo["m.devices"];
                const deviceIndex = devicesInfo.findIndex(d => d["device_id"] === this.options.ownDeviceId);
                if (deviceIndex !== -1) {
                    devicesInfo.splice(deviceIndex, 1);
                    return content;
                }
            }

        }
    }

    private connectToMember(member: Member, joinedData: JoinedData, log: ILogItem) {
        const logItem = joinedData.membersLogItem.child({l: "member", id: getMemberKey(member.userId, member.deviceId)});
        logItem.set("sessionId", member.sessionId);
        log.refDetached(logItem);
        // Safari can't send a MediaStream to multiple sources, so clone it
        member.connect(joinedData.localMedia.clone(), joinedData.localMuteSettings, logItem);
    }

    protected emitChange() {
        this.emit("change");
        this.options.emitUpdate(this);
    }
}
