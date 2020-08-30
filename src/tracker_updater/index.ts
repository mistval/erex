import fetch, { Response } from 'node-fetch';
import { Client } from 'eris';
import { EventEmitter } from 'events';

const NO_API_KEY_ERROR_CODE = 'NO_API_KEY';
const FAILED_REQUEST_ERROR_CODE = 'REQUEST_FAILED';

type ApiKeyDict = {
  discordBotsDotOrgAPIKey?: string,
  discordDotBotsDotGgAPIKey?: string,
  botsOnDiscordDotXyzAPIKey?: string,
  discordBotListDotComAPIKey?: string,
  discordDotBoatsAPIKey?: string,
};

type CodedError = Error & { code: string };
type StatsSendError = CodedError & {
  ok: false,
  code: 'REQUEST_FAILED',
  response: Response,
  target: string,
  payload: object,
  stats: {
    users: number | undefined,
    guilds: number | undefined,
    shards: number | undefined,
  },
};

type StatsSendInfo = {
  ok: true,
  target: string,
  payload: object,
  stats: {
    users: number | undefined,
    guilds: number | undefined,
    shards: number | undefined,
  },
};

function createNoApiKeyError() {
  const error = new Error('No API key was provided for that tracker.') as CodedError;
  error.code = NO_API_KEY_ERROR_CODE;

  return error;
}

class TrackerStatsUpdater extends EventEmitter {
  private _client: Client;
  private _apiKeyDict: ApiKeyDict;

  constructor(erisClient: Client, apiKeys: ApiKeyDict) {
    super();
    this._client = erisClient;
    this._apiKeyDict = apiKeys;
  }

  private _handleResponse(response: Response, target: string, payload: any) : StatsSendInfo {
    const stats = {
      users: payload.users,
      guilds: payload.guilds ?? payload.guildCount ?? payload.server_count,
      shards: payload.shard_count ?? payload.shardCount,
    };

    if (response.ok) {
      return { target, payload, stats, ok: true };
    } else {
      const error = new Error(`Non-okay status ${response.status} from ${target}.`) as StatsSendError;
      error.ok = false;
      error.code = FAILED_REQUEST_ERROR_CODE;
      error.target = target;
      error.payload = payload;
      error.stats = stats;
      error.response = response;
      throw error;
    }
  }

  async updateDiscordBotListDotCom() {
    if (!this._apiKeyDict.discordBotListDotComAPIKey) {
      throw createNoApiKeyError();
    }

    const payload = {
      users: this._client.guilds.map(guild => guild.memberCount).reduce((x, y) => x + y, 0),
      guilds: this._client.guilds.size,
    };

    const response = await fetch(`https://discordbotlist.com/api/v1/bots/${this._client.user.id}/stats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this._apiKeyDict.discordBotListDotComAPIKey,
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    return this._handleResponse(response, 'discordbotlist.com', payload);
  }

  async updateBotsOnDiscordDotXyz() {
    if (!this._apiKeyDict.botsOnDiscordDotXyzAPIKey) {
      throw createNoApiKeyError();
    }

    const payload = {
      guildCount: this._client.guilds.size,
    };

    const response = await fetch(`https://bots.ondiscord.xyz/bot-api/bots/${this._client.user.id}/guilds`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this._apiKeyDict.botsOnDiscordDotXyzAPIKey,
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    return this._handleResponse(response, 'bots.ondiscord.xyz', payload);
  }

  async updateDiscordBotsDotOrg() {
    if (!this._apiKeyDict.discordBotsDotOrgAPIKey) {
      throw createNoApiKeyError();
    }

    const payload = {
      server_count: this._client.guilds.size,
      shard_count: this._client.shards.size,
    };

    const response = await fetch(`https://discordbots.org/api/bots/${this._client.user.id}/stats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this._apiKeyDict.discordBotsDotOrgAPIKey,
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    return this._handleResponse(response, 'discordbots.org', payload);
  }

  async updateDiscordDotBotsDotGg() {
    if (!this._apiKeyDict.discordDotBotsDotGgAPIKey) {
      throw createNoApiKeyError();
    }

    const payload = {
      guildCount: this._client.guilds.size,
      shardCount: this._client.shards.size,
    };

    const response = await fetch(`https://discord.bots.gg/api/v1/bots/${this._client.user.id}/stats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this._apiKeyDict.discordDotBotsDotGgAPIKey,
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    return this._handleResponse(response, 'discord.bots.gg', payload);
  }

  async updateDiscordDotBoats() {
    if (!this._apiKeyDict.discordDotBoatsAPIKey) {
      throw createNoApiKeyError();
    }

    const payload = {
      server_count: this._client.guilds.size,
    };

    const response = await fetch(`https://discord.boats/api/bot/${this._client.user.id}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this._apiKeyDict.discordDotBoatsAPIKey,
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    return this._handleResponse(response, 'discord.boats', payload);
  }

  async updateAll() {
    const results = await Promise.allSettled([
      this.updateDiscordDotBotsDotGg(),
      this.updateDiscordBotsDotOrg(),
      this.updateBotsOnDiscordDotXyz(),
      this.updateDiscordBotListDotCom(),
      this.updateDiscordDotBoats(),
    ]);


    const successes = results
      .filter(r => r.status === 'fulfilled')
      .map(r => (r as PromiseFulfilledResult<StatsSendInfo>).value);

    const errors = results
      .filter(r => r.status === 'rejected' && r.reason.code !== NO_API_KEY_ERROR_CODE)
      .map(r => (r as PromiseRejectedResult).reason);

    return [...successes, ...errors];
  }
}

module.exports = TrackerStatsUpdater;
