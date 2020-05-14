/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as Is from './is';
import { Event, Emitter } from './events';
import { Message } from './messages';
import { ReadableStream } from './streams';

export interface DataCallback {
	(data: Message): void;
}

export interface PartialMessageInfo {
	readonly messageToken: number;
	readonly waitingTime: number;
}

export interface MessageReader {
	readonly onError: Event<Error>;
	readonly onClose: Event<void>;
	readonly onPartialMessage: Event<PartialMessageInfo>;
	listen(callback: DataCallback): void;
	dispose(): void;
}

export namespace MessageReader {
	export function is(value: any): value is MessageReader {
		let candidate: MessageReader = value;
		return candidate && Is.func(candidate.listen) && Is.func(candidate.dispose) &&
			Is.func(candidate.onError) && Is.func(candidate.onClose) && Is.func(candidate.onPartialMessage);
	}
}

export abstract class AbstractMessageReader {

	private errorEmitter: Emitter<Error>;
	private closeEmitter: Emitter<void>;

	private partialMessageEmitter: Emitter<PartialMessageInfo>;

	constructor() {
		this.errorEmitter = new Emitter<Error>();
		this.closeEmitter = new Emitter<void>();
		this.partialMessageEmitter = new Emitter<PartialMessageInfo>();
	}

	public dispose(): void {
		this.errorEmitter.dispose();
		this.closeEmitter.dispose();
	}

	public get onError(): Event<Error> {
		return this.errorEmitter.event;
	}

	protected fireError(error: any): void {
		this.errorEmitter.fire(this.asError(error));
	}

	public get onClose(): Event<void> {
		return this.closeEmitter.event;
	}

	protected fireClose(): void {
		this.closeEmitter.fire(undefined);
	}

	public get onPartialMessage(): Event<PartialMessageInfo> {
		return this.partialMessageEmitter.event;
	}

	protected firePartialMessage(info: PartialMessageInfo): void {
		this.partialMessageEmitter.fire(info);
	}

	private asError(error: any): Error {
		if (error instanceof Error) {
			return error;
		} else {
			return new Error(`Reader received error. Reason: ${Is.string(error.message) ? error.message : 'unknown'}`);
		}
	}
}

export class StreamMessageReader extends AbstractMessageReader implements MessageReader {

	private readable: ReadableStream;
	private options: ResolvedMessageReaderOptions;
	private callback!: DataCallback;

	private nextMessageLength: number;
	private messageToken: number;
	private buffer: MessageBuffer;
	private partialMessageTimer: NodeJS.Timer | undefined;
	private _partialMessageTimeout: number;

	public constructor(readable: ReadableStream, options?: BufferEncoding | MessageReaderOptions) {
		super();
		this.readable = readable;
		this.buffer = new MessageBuffer();
		this.options = ResolvedMessageReaderOptions.fromOptions(options);
		this._partialMessageTimeout = 10000;
		this.nextMessageLength = -1;
		this.messageToken = 0;
	}

	public set partialMessageTimeout(timeout: number) {
		this._partialMessageTimeout = timeout;
	}

	public get partialMessageTimeout(): number {
		return this._partialMessageTimeout;
	}

	public listen(callback: DataCallback): void {
		this.nextMessageLength = -1;
		this.messageToken = 0;
		this.partialMessageTimer = undefined;
		this.callback = callback;
		this.readable.onData((data: Uint8Array) => {
			this.onData(data);
		});
		this.readable.onError((error: any) => this.fireError(error));
		this.readable.onClose(() => this.fireClose());
	}

	private onData(data: Buffer | String): void {
		this.buffer.append(data);
		while (true) {
			if (this.nextMessageLength === -1) {
				const headers = this.buffer.tryReadHeaders();
				if (!headers) {
					return;
				}
				const contentLength = headers['Content-Length'];
				if (!contentLength) {
					throw new Error('Header must provide a Content-Length property.');
				}
				const length = parseInt(contentLength);
				if (isNaN(length)) {
					throw new Error('Content-Length value must be a number.');
				}
				this.nextMessageLength = length;
			}
			const body = this.buffer.tryReadBody(this.nextMessageLength);
			if (body === undefined) {
				/** We haven't received the full message yet. */
				this.setPartialMessageTimer();
				return;
			}
			this.clearPartialMessageTimer();
			this.nextMessageLength = -1;
			let p: Promise<Uint8Array>;
			if (this.options.contentDecoder !== undefined) {
				p = this.options.contentDecoder.decode(body);
			} else {
				p = Promise.resolve(body);
			}
			p.then((value) => {
				this.options.contentTypeDecoder.decode(value, this.options).then((msg: Message) => {
					this.callback(msg);
				}, (error) => {
					this.fireError(error);
				});
			}, (error) => {
				this.fireError(error);
			});
		}
	}

	private clearPartialMessageTimer(): void {
		if (this.partialMessageTimer) {
			clearTimeout(this.partialMessageTimer);
			this.partialMessageTimer = undefined;
		}
	}

	private setPartialMessageTimer(): void {
		this.clearPartialMessageTimer();
		if (this._partialMessageTimeout <= 0) {
			return;
		}
		this.partialMessageTimer = setTimeout((token, timeout) => {
			this.partialMessageTimer = undefined;
			if (token === this.messageToken) {
				this.firePartialMessage({ messageToken: token, waitingTime: timeout });
				this.setPartialMessageTimer();
			}
		}, this._partialMessageTimeout, this.messageToken, this._partialMessageTimeout);
	}
}