/** @flow */
import type { IdP } from './idp'
import type { EndpointConfig } from './identity-provider.js.flow'
import type { IAbstractStorage as AbstractStorage } from './storage.js.flow'
import type { AccountConfig, TokenData, TRefreshReponse, TRevokeResponse } from './account.js.flow'
import { fetchRetry, isExpired, validResponse, parsedResponse, parse } from './utils/index'

const MAX_AJAX_RETRY = 3
const AJAX_RETRY_DELAY = 1000
const LEEWAY = 3000

export default class Account<Config: AccountConfig, Storage: AbstractStorage> {
  fetchFn: Function;

  fetchOpts: Object;

  id: string;

  label: string;

  leeway: number;

  requestMode: 'label' | 'id';

  provider: IdP<EndpointConfig>;

  retries: number;

  retryDelay: number;

  storage: Storage;

  constructor (config: Config, storage: Storage) {
    if (!config || !config.provider) throw new TypeError('Missing `provider` in config')

    if (!storage) throw new TypeError('Storage is not defined')

    this.storage = storage
    this.provider = config.provider
    this.fetchFn = fetchRetry
    this.fetchOpts = {
      delay: config.retryDelay || AJAX_RETRY_DELAY,
      retries: config.retries || MAX_AJAX_RETRY,
    }
    this.leeway = config.leeway || LEEWAY
    this.requestMode = config.requestMode || 'id'

    const { id, label } = this._createId(config.audience, config.label)

    this.label = label
    this.id = id

    if (!this.id) throw new TypeError('Failed to configure account. Id is not present')
  }

  // eslint-disable-next-line class-methods-use-this
  _createId (audience: string, label: string = 'me', separator: string = '.'): { label: string, id: string } {
    if (!audience) throw new TypeError('`audience` is absent')

    return {
      label,
      id: `${label}${separator}${audience}`,
    }
  }

  _requestLabel (): string {
    return this.requestMode === 'label' ? this.label : this.id
  }

  load (storageLabel: string = ''): Promise<TokenData> {
    const label = storageLabel || this.id
    if (!label) return Promise.reject(new TypeError('`label` is absent'))

    return Promise.resolve(() => this.storage.getItem(label))
      .then((fn) => {
        const value = fn()
        if (!value) throw new TypeError('Can not load data')

        return parse(value)
      })
  }

  remove (storageLabel: string = ''): Promise<TokenData> {
    const label = storageLabel || this.id
    if (!label) return Promise.reject(new TypeError('`label` is absent'))

    return this.load(label)
      .then((tokenData) => {
        this.storage.removeItem(label)

        return tokenData
      })
  }

  store (data: TokenData, storageLabel: string = ''): Promise<TokenData> {
    const label = storageLabel || this.id
    if (!label) return Promise.reject(new TypeError('`label` is absent'))

    return Promise.resolve(data)
      .then((_) => {
        let expires_time: number = 0

        if (_.expires_in) {
          const expin = Number(_.expires_in)
          if (isNaN(expin)) throw new TypeError('Wrong `expires_in` value')
          expires_time = Date.now() + (expin || 0) * 1e3
        }

        return ({ ..._, expires_time })
      })
      .then((_) => {
        this.storage.setItem(label, JSON.stringify(_))

        return _
      })
  }

  account (storageLabel: string = ''): Promise<TokenData> {
    const label = storageLabel || this.id

    return this.tokenData(label)
      .then((data: TokenData) => {
        const { access_token } = data

        return this.provider.account(this._requestLabel(), access_token)
      })
      .then((req: Request) => this.fetchFn(() => req, this.fetchOpts))
      .then(validResponse)
      .then(parsedResponse)
  }

  tokenData (storageLabel: string = ''): Promise<TokenData> {
    const label = storageLabel || this.id

    return this.load(label)
      .then((maybeValidTokens: TokenData) => {
        const expired = isExpired(maybeValidTokens, this.leeway)

        if (!expired) return maybeValidTokens

        const { refresh_token } = maybeValidTokens

        return this.provider.refreshAccessToken(this._requestLabel(), refresh_token)
      })
      .then((req: Request) => this.fetchFn(() => req, this.fetchOpts))
      .then(validResponse)
      .then(parsedResponse)
      // eslint-disable-next-line promise/no-nesting
      .then((_: TRefreshReponse) => this.load(label)
        .then(old => this.store({
          ...old,
          access_token: _.access_token,
          expires_in: _.expires_in,
        })))
  }

  revokeRefreshToken (storageLabel: string = ''): Promise<TokenData> {
    const label = storageLabel || this.id

    return this.load(label)
      .then((maybeToken) => {
        const { refresh_token } = maybeToken

        return this.provider.revokeRefreshToken(this._requestLabel(), refresh_token)
      })
      .then((req: Request) => this.fetchFn(() => req, this.fetchOpts))
      .then(validResponse)
      .then(parsedResponse)
      // eslint-disable-next-line promise/no-nesting
      .then((_: TRevokeResponse) => this.load(label)
        .then(old => this.store({
          ...old,
          refresh_token: _.refresh_token,
        })))
  }
}

export { Account }
