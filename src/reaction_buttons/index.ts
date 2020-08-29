import { Message, Emoji, GuildTextableChannel } from 'eris';
import { EventEmitter } from 'events';

type ReactionHandlerFunc = (msg: Message, emoji: Emoji, userId: string, added: boolean) => any;
type HandlerFuncForReactionDictionary = { [reaction: string]: ReactionHandlerFunc };
type UnregisterOptions = { removeButtons: boolean };

export class ReactionButtonsContext {
  private _selfUserId: string;
  private _msg: Message;
  private _disabled: boolean = false;
  private _allowReactionsFrom: string[];
  _handlerFuncForReaction: HandlerFuncForReactionDictionary;
  _timeoutHandle: NodeJS.Timeout;
  unregister: (options: UnregisterOptions) => Promise<any>;

  constructor(
    selfUserId: string,
    msg: Message,
    allowReactionsFrom: string[],
    handlerFuncForReaction: HandlerFuncForReactionDictionary,
    timeoutHandle: NodeJS.Timeout,
    unregister: (options: UnregisterOptions) => Promise<any>,
  ) {
    this._selfUserId = selfUserId;
    this._msg = msg;
    this._handlerFuncForReaction = handlerFuncForReaction;
    this._timeoutHandle = timeoutHandle;
    this._allowReactionsFrom = allowReactionsFrom;
    this.unregister = unregister;

    Object.entries(handlerFuncForReaction).forEach(([reaction, func]) => {
      handlerFuncForReaction[reaction] = func.bind(this);
    });
  }

  async _initialize() {
    let error;
    for (let reaction of Object.keys(this._handlerFuncForReaction)) {
      try {
        await this._msg.addReaction(reaction);
      } catch (err) {
        // TODO: Dont try to add more buttons if permission error.
        // TODO: Retries
        error = err;
      }
    }

    if (error) {
      throw error;
    }
  }

  private _canRemoveOtherUserReactions() {
    const guildChannel = this._msg.channel as GuildTextableChannel;
    return guildChannel.guild && guildChannel.permissionsOf(this._selfUserId).has('manageMessages');
  }

  async removeButton(reaction: string) {
    if (this._handlerFuncForReaction[reaction]) {
      delete this._handlerFuncForReaction[reaction];

      if (this._canRemoveOtherUserReactions()) {
        await this._msg.removeMessageReactionEmoji(reaction);
      } else {
        await this._msg.removeReaction(reaction);
      }
    }
  }

  async removeAllButtons() {
    this._handlerFuncForReaction = {};
    if (this._canRemoveOtherUserReactions()) {
      await this._msg.removeReactions();
    }
  }

  async addButton(reaction: string, handlerFunc: ReactionHandlerFunc) {
    if (this._handlerFuncForReaction[reaction]) {
      throw new Error('A handler is already registered for that button. Use removedButton to remove it.');
    }

    await this._msg.addReaction(reaction);

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

export class ReactionButtonManager extends EventEmitter {
  selfUserId: string;
  expirationTimeInMs: number;
  removeButtonsOnUnregister: boolean;
  contextForMessageId: { [messageId: string]: ReactionButtonsContext };

  constructor(selfUserId: string, options: { expirationTimeInMs?: number, removeButtonsOnUnregister?: boolean } = {}) {
    super();
    this.expirationTimeInMs = options.expirationTimeInMs || 60000;
    this.removeButtonsOnUnregister = options.removeButtonsOnUnregister || false;
    this.contextForMessageId = {};
    this.selfUserId = selfUserId;
  }

  handleMessageReactionAdd(msg: Message, emoji: Emoji, userId: string) {
    const context = this.contextForMessageId[msg.id];
    if (context) {
      context._handleMessageReaction(msg, emoji, userId, true);
    }
  }

  handleMessageReactionRemove(msg: Message, emoji: Emoji, userId: string) {
    const context = this.contextForMessageId[msg.id];
    if (context) {
      context._handleMessageReaction(msg, emoji, userId, false);
    }
  }

  async unregisterHandler(msg: Message, options: UnregisterOptions) {
    const context = this.contextForMessageId[msg.id];
    if (context) {
      delete this.contextForMessageId[msg.id];
      clearTimeout(context._timeoutHandle);

      if (options.removeButtons) {
        await context.removeAllButtons();
      }
    }
  }

  async registerHandler(
    msg: Message,
    allowReactionsFrom: string[],
    handlerFuncForReaction: HandlerFuncForReactionDictionary,
    options: { expirationTimeInMs?: number, removeButtonsOnExpire?: boolean } = {},
  ) {
    if (this.contextForMessageId[msg.id] !== undefined) {
      throw new Error('There is already a reaction button handler registered for that message');
    }

    const timeoutMs = options.expirationTimeInMs || this.expirationTimeInMs;
    const removeButtonsOnExpire = options.removeButtonsOnExpire || this.removeButtonsOnUnregister;

    const timeoutHandle = setTimeout(async () => {
      try {
        await this.unregisterHandler(msg, { removeButtons: removeButtonsOnExpire });
      } catch (err) {
        this.emit('error', { msg, err });
      }
    }, timeoutMs);

    const context = new ReactionButtonsContext(
      this.selfUserId,
      msg,
      allowReactionsFrom,
      handlerFuncForReaction,
      timeoutHandle,
      (unregisterOptions: UnregisterOptions) => this.unregisterHandler(msg, unregisterOptions),
    );

    this.contextForMessageId[msg.id] = context;
    await context._initialize();

    return context;
  }
}
