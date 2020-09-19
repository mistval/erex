import { Message, Emoji, GuildTextableChannel } from 'eris';
import retryPromise from '../util/retry_promise';

export type ReactionHandlerFunc = (msg: Message, emoji: Emoji, userId: string, added: boolean) => any;
export type HandlerFuncForReactionDictionary = { [reaction: string]: ReactionHandlerFunc };

interface ContextObserver {
  _onCancel: (msgId: string) => any;
}

export class ReactionButtonsContext {
  private _selfUserId: string;
  private _msg: Message;
  private _allowReactionsFrom: string[];
  private _handlerFuncForReaction: HandlerFuncForReactionDictionary;
  private _timeoutMs: number;
  private _observer: ContextObserver;
  private _disabled: boolean = false;
  private _timeoutHandle?: NodeJS.Timeout;

  constructor(
    selfUserId: string,
    msg: Message,
    allowReactionsFrom: string[],
    handlerFuncForReaction: HandlerFuncForReactionDictionary,
    timeoutMs: number,
    observer: ContextObserver,
  ) {
    this._selfUserId = selfUserId;
    this._msg = msg;
    this._allowReactionsFrom = allowReactionsFrom;
    this._timeoutMs = timeoutMs;
    this._observer = observer;

    this._handlerFuncForReaction = Object.fromEntries(
      Object.entries(handlerFuncForReaction).map(([reaction, func]) => [
        reaction,
        func.bind(this),
      ]),
    );
  }

  async _initialize() {
    setTimeout(() => {
      this.cancel();
    }, this._timeoutMs);

    if (!this._canAddReactions()) {
      const err = new Error('Do not have permission to add reactions.');
      (err as any).code = 60013;
      throw err;
    }

    for (let reaction of Object.keys(this._handlerFuncForReaction)) {
      await retryPromise(() => this._msg.addReaction(reaction));
    }
  }

  private _canAddReactions() {
    const guildChannel = this._msg.channel as GuildTextableChannel;
    if (!guildChannel.guild) {
      return true;
    }

    const permissions = guildChannel.permissionsOf(this._selfUserId);
    return permissions.has('addReactions') && permissions.has('readMessageHistory');
  }

  private _canRemoveOtherUserReactions() {
    const guildChannel = this._msg.channel as GuildTextableChannel;
    return guildChannel.guild && guildChannel.permissionsOf(this._selfUserId).has('manageMessages');
  }

  async cancel() {
    if (this._timeoutHandle) {
      clearTimeout(this._timeoutHandle);
    }

    this._observer._onCancel(this._msg.id);
    await this.removeAllButtons();
  }

  async removeButton(reaction: string) {
    if (this._handlerFuncForReaction[reaction]) {
      delete this._handlerFuncForReaction[reaction];

      if (this._canRemoveOtherUserReactions()) {
        await retryPromise(() => this._msg.removeMessageReactionEmoji(reaction));
      } else {
        await retryPromise(() => this._msg.removeReaction(reaction));
      }
    }
  }

  async removeAllButtons() {
    const reactions = Object.keys(this._handlerFuncForReaction);
    this._handlerFuncForReaction = {};
    if (this._canRemoveOtherUserReactions()) {
      await retryPromise(() => this._msg.removeReactions());
    } else {
      await Promise.all(
        reactions.map(reaction => retryPromise(() => this._msg.removeReaction(reaction))),
      );
    }
  }

  async addButton(reaction: string, handlerFunc: ReactionHandlerFunc) {
    if (this._handlerFuncForReaction[reaction]) {
      throw new Error('A handler is already registered for that button. Use removedButton to remove it.');
    }

    await retryPromise(() => this._msg.addReaction(reaction));

    handlerFunc.bind(this);
    this._handlerFuncForReaction[reaction] = handlerFunc;
  }

  disable() {
    this._disabled = true;
  }

  enable() {
    this._disabled = false;
  }

  async _handleMessageReaction(msg: Message, emoji: Emoji, userId: string, added: boolean) {
    if (this._disabled) {
      return;
    }

    if (userId === this._selfUserId) {
      return;
    }

    if (this._allowReactionsFrom.length > 0 && !this._allowReactionsFrom.includes(userId)) {
      return;
    }

    const handlerFunc = this._handlerFuncForReaction[emoji.name];

    if (handlerFunc === undefined) {
      return false;
    }

    await handlerFunc(msg, emoji, userId, added);
    return true;
  }
}

export class ReactionButtonManager implements ContextObserver {
  selfUserId: string;
  expirationTimeInMs: number;
  contextForMessageId: { [messageId: string]: ReactionButtonsContext } = {};

  constructor(selfUserId: string, options: { expirationTimeInMs?: number } = {}) {
    if (!selfUserId) {
      throw new Error('Must pass in bot\'s own ID as first constructor argument.');
    }

    this.expirationTimeInMs = options.expirationTimeInMs || 120000;
    this.selfUserId = selfUserId;
  }

  handleMessageReactionAdd(msg: Message, emoji: Emoji, userId: string) {
    const context = this.contextForMessageId[msg.id];
    if (context) {
      return context._handleMessageReaction(msg, emoji, userId, true);
    }

    return undefined;
  }

  handleMessageReactionRemove(msg: Message, emoji: Emoji, userId: string) {
    const context = this.contextForMessageId[msg.id];
    if (context) {
      return context._handleMessageReaction(msg, emoji, userId, false);
    }

    return undefined;
  }

  _onCancel(msgId: string) {
    delete this.contextForMessageId[msgId];
  }

  async add(
    msg: Message,
    allowReactionsFrom: string[],
    handlerFuncForReaction: HandlerFuncForReactionDictionary,
    options: { expirationTimeInMs?: number } = {},
  ) {
    if (this.contextForMessageId[msg.id] !== undefined) {
      throw new Error('There is already a reaction button handler registered for that message');
    }

    const timeoutMs = options.expirationTimeInMs || this.expirationTimeInMs;

    const context = new ReactionButtonsContext(
      this.selfUserId,
      msg,
      allowReactionsFrom,
      handlerFuncForReaction,
      timeoutMs,
      this,
    );

    this.contextForMessageId[msg.id] = context;
    await context._initialize();

    return context;
  }
}
