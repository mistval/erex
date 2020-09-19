import { TextChannel, MessageContent, Message } from "eris";
import { ReactionButtonManager, HandlerFuncForReactionDictionary } from "../reaction_buttons";
import retryPromise from '../util/retry_promise';
import assert from 'assert';

const LEFT_BUTTON = '⬅';
const RIGHT_BUTTON = '➡';
const DEBOUNCE_INTERVAL_MS = 1000;

interface PageSource {
  getPage: (pageNum: number) => Promise<MessageContent> | MessageContent;
}

class Debouncer {
  private _func: () => any = () => {};
  private _debouncePromise?: Promise<any>;
  private _pending = false;

  constructor(func: () => any) {
    this._func = func;
  }

  async exec() {
    if (this._debouncePromise) {
      this._pending = true;
      return this._debouncePromise;
    }

    const execPromise = this._func();

    this._debouncePromise = new Promise((fulfill) => {
      setTimeout(() => {
        fulfill(this._pending ? this._func() : undefined);
        this._debouncePromise = undefined;
        this._pending = false;
      }, DEBOUNCE_INTERVAL_MS);
    });

    return execPromise;
  }
}

export class PageController {
  private _pageCache: { [emoji: string]: { [pageNum: string]: MessageContent } } = {};
  private _pageSourceForEmoji: { [emoji: string]: PageSource };
  private _maxPageForEmoji: { [emoji: string]: number } = {};
  private _currentPageNum = 0;
  private _currentEmoji = '';
  private _lastSentEmoji = '';
  private _lastSentPageNum = 0;
  private _showArrows = true;
  private _message?: Message;
  private _editDebouncer = new Debouncer(this._editWithCurrentState.bind(this));

  constructor(pageSourceForEmoji: { [emoji: string]: PageSource }, showArrows = true) {
    this._pageSourceForEmoji = pageSourceForEmoji;
    this._currentEmoji = Object.keys(pageSourceForEmoji)[0];
    this._lastSentEmoji = this._currentEmoji;
    this._showArrows = showArrows;

    this._maxPageForEmoji = Object.fromEntries(
      Object.keys(pageSourceForEmoji).map(emoji => [
        emoji,
        Number.MAX_SAFE_INTEGER,
      ]),
    );
  }

  static fromOneDimensionalContent(content: Array<Promise<MessageContent> | MessageContent>) {
    const pageSource = {
      getPage(pageNum: number) {
        return content[pageNum];
      }
    }

    return new PageController({ '': pageSource });
  }

  private async _initReactionButtons(
    allowedReactors: string[],
    expirationTimeInMs: number,
    reactionButtonManager: ReactionButtonManager,
  ) {
    assert(this._message, 'No message');

    const handlerForReaction: HandlerFuncForReactionDictionary = {};
    const self = this;

    const emojis = Object.keys(this._pageSourceForEmoji);

    if (emojis.length > 1) {
      for (const emoji of Object.keys(this._pageSourceForEmoji)) {
        handlerForReaction[emoji] = function() {
          return self._moveEmoji(emoji);
        }
      }
    }

    if (this._showArrows) {
      handlerForReaction[LEFT_BUTTON] = function() {
        return self._movePageNum(-1);
      };

      handlerForReaction[RIGHT_BUTTON] = function() {
        return self._movePageNum(1);
      }
    }

    return reactionButtonManager.add(
      this._message!,
      allowedReactors,
      handlerForReaction,
      { expirationTimeInMs },
    );
  }

  async _init(
    channel: TextChannel,
    allowedReactors: string[],
    expirationTimeInMs: number,
    reactionButtonManager: ReactionButtonManager,
  ) {
    this._currentPageNum = await this._coerceAndCachePage(this._currentPageNum);
    const firstPage = this._getCurrentPage();

    if (!firstPage) {
      throw new Error('Invalid first page');
    }

    this._message = await retryPromise(() => channel.createMessage(firstPage));
    await this._initReactionButtons(allowedReactors, expirationTimeInMs, reactionButtonManager);

    return this._message;
  }

  private _getCurrentPage() {
    return this._pageCache[this._currentEmoji][this._currentPageNum];
  }

  private async _coerceAndCachePage(pageNum: number) {
    const maxPage = this._maxPageForEmoji[this._currentEmoji];
    const cacheForCurrentEmoji = this._pageCache[this._currentEmoji];

    if (pageNum < 0) {
      pageNum = 0;
    }

    if (pageNum > maxPage) {
      pageNum = maxPage;
    }

    if (cacheForCurrentEmoji[pageNum]) {
      return pageNum;
    }

    const pageSource = this._pageSourceForEmoji[this._currentEmoji];

    let page = await pageSource.getPage(pageNum);
    while (!page && --pageNum >= 0) {
      page = await pageSource.getPage(pageNum);

      if (page) {
        this._maxPageForEmoji[this._currentEmoji] = pageNum;
      }
    }

    if (!page && pageNum === 0) {
      throw new Error('Failed to get first page');
    }

    cacheForCurrentEmoji[pageNum] = page;
    return pageNum;
  }

  private async _editWithCurrentState() {
    assert(this._message, 'No message');

    if (
      this._currentEmoji === this._lastSentEmoji
      && this._currentPageNum === this._lastSentPageNum
    ) {
      return;
    }

    this._lastSentEmoji = this._currentEmoji;
    this._lastSentPageNum = this._currentPageNum;

    const currentPage = this._getCurrentPage();
    await retryPromise(() => this._message!.edit(currentPage));
  }

  async _movePageNum(distance: number) {
    const newPageNum = await this._coerceAndCachePage(this._currentPageNum + distance);
    if (newPageNum === this._currentPageNum) {
      return undefined;
    }

    this._currentPageNum = newPageNum;
    return this._editDebouncer.exec();
  }

  async _moveEmoji(emoji: string) {
    if (emoji === this._currentEmoji) {
      return undefined;
    }

    this._currentEmoji = emoji;
    this._currentPageNum = 0;
    return this._editDebouncer.exec();
  }
}

export class PaginationManager {
  private _expirationTimeInMs: number;
  private _reactionButtonManager: ReactionButtonManager;

  constructor(
    reactionButtonManager: ReactionButtonManager,
    options: { expirationTimeInMs?: number } = {},
  ) {
    this._reactionButtonManager = reactionButtonManager;
    this._expirationTimeInMs = options.expirationTimeInMs || 120000;
  }

  async add(
    channel: TextChannel,
    allowedReactors: string[],
    controller: PageController,
    options: { expirationTimeInMs?: number } = {}
  ) {
    const expirationTimeInMs = options.expirationTimeInMs || this._expirationTimeInMs;
    return controller._init(channel, allowedReactors, expirationTimeInMs, this._reactionButtonManager);
  }
}
