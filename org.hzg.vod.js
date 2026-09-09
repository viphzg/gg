// ==MiruExtension==
// @name        HZG 点播
// @version     1.1.1
// @author      HZG
// @lang        all
// @license     AGPL-3.0
// @package     org.hzg.vod
// @type        bangumi
// @icon        https://repo.example.com/icon.png
// @webSite     https://example.com
// @description 添加点播数据源（TVBox 类接口 / AppleCMS 影视 API）：直接填接口地址（含根域名）即出分类、列表、搜索、详情、播放；数据源完全由你自己提供
// ==/MiruExtension==

import { Extension } from 'extension';

export default class Vod extends Extension {
  async load() {
    this.registerSetting({
      key: 'api',
      title: '数据源地址',
      type: 'input',
      defaultValue: '',
      description: '点播接口地址，支持多行（每行一个）：可直接填根域名如 https://接口域名，或 .json 配置地址 / 影视 API 地址',
    });
    this.registerSetting({
      key: 'referer',
      title: '播放 Referer（可选）',
      type: 'input',
      defaultValue: '',
      description: '部分播放地址需要携带 Referer 才能播放，留空则不携带',
    });
    this.registerSetting({
      key: 'ua',
      title: 'User-Agent（可选）',
      type: 'input',
      defaultValue: 'okhttp/3.12.1',
      description: '访问接口与播放地址使用的 User-Agent；多数接口站要求 okhttp，默认已设置',
    });
  }

  _splitUrl(url) {
    const m = String(url).match(/^(https?:\/\/[^/]+)(\/.*)?$/);
    return m ? { host: m[1], path: m[2] || '/' } : null;
  }

  _hostName(host) {
    return String(host).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  }

  _normApi(api, cfgUrl) {
    const a = String(api).trim();
    if (/^https?:\/\//i.test(a)) return a;
    // 相对路径：基于配置地址的 host 拼接
    const parts = this._splitUrl(cfgUrl);
    const host = parts ? parts.host : cfgUrl;
    return host + (a.startsWith('/') ? a : '/' + a);
  }

  async _hdr(host) {
    const h = { 'Miru-Url': host, 'User-Agent': String((await this.getSetting('ua')) || 'okhttp/3.12.1') };
    return h;
  }

  async _fetchText(url) {
    const parts = this._splitUrl(url);
    if (!parts) throw new Error('数据源地址无效: ' + url);
    return this.request(parts.path, { headers: await this._hdr(parts.host) });
  }

  async _fetchJson(url) {
    const res = await this._fetchText(url);
    if (typeof res === 'string') {
      let t = res.trim();
      if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
      return JSON.parse(t);
    }
    return res;
  }

  // 把一个输入行解析成站点列表；输入可能是：根域名 / .json 配置 / 直连 API
  async _parseLine(line) {
    const out = [];
    const isJsonCfg = /\.(json|txt)(\?|$)/i.test(line);
    const isDirectApi = /(api\.php|provide\/vod|\?)($|\/)/i.test(line);
    let data = null;
    if (isJsonCfg) {
      data = await this._fetchJson(line);
    } else if (isDirectApi) {
      // 直连影视 API：直接作为单站点
      const parts = this._splitUrl(line);
      if (!parts) throw new Error('地址无效: ' + line);
      out.push({ key: this._hostName(line), name: this._hostName(line), api: line });
      return out;
    } else {
      // 根地址：请求其根路径，返回 JSON 视为 TVBox 配置；返回 HTML 则尝试提取接口链接
      try {
        data = await this._fetchJson(line.replace(/\/+$/, '') + '/');
      } catch (e) {
        const html = String(await this._fetchText(line));
        if (html) {
          const m = html.match(/https?:\/\/[^"'\s<>]+(?:api\.php[^"'\s<>]*|provide\/vod[^"'\s<>]*|\.json[^"'\s<>]*)/i);
          if (m) {
            data = await this._fetchJson(m[0]);
          }
        }
      }
    }
    if (!data) throw new Error('地址无法解析出接口数据: ' + line);
    let arr = data && Array.isArray(data.sites) ? data.sites : (Array.isArray(data) ? data : []);
    if (!arr.length && data && data.api) arr = [data];
    for (const s of arr) {
      const api = s.api || s.url || (s.urls && s.urls[0]) || (s.spiderUrl && s.spiderUrl[0]);
      if (!api) continue;
      const apiStr = String(api);
      // 仅接受 http 直连影视 API；.jar / drpy / .js 等爬虫脚本无法在 JS 扩展中执行，过滤掉
      const isSpiderScript = /\.jar(\?|$)/i.test(apiStr) || /drpy/i.test(apiStr) || /\.js(\?|$)/i.test(apiStr);
      if (/^https?:\/\//i.test(apiStr) && !isSpiderScript) {
        out.push({
          key: String(s.key || s.name || apiStr),
          name: String(s.name || s.title || this._hostName(apiStr)),
          api: apiStr,
        });
      }
    }
    return out;
  }

  async _loadSites() {
    const raw = String((await this.getSetting('api')) || '').trim();
    if (!raw) throw new Error('请先在扩展设置中填写数据源地址');
    const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const sites = [];
    let idx = 0;
    for (const line of lines) {
      let parsed;
      try {
        parsed = await this._parseLine(line);
      } catch (e) {
        throw new Error('数据源 ' + line + ' 解析失败：' + e.message);
      }
      for (const s of parsed) {
        sites.push({ key: 'S' + idx++, name: s.name, api: this._normApi(s.api, line) });
      }
    }
    if (!sites.length) {
      throw new Error(
        '该接口没有可用的直连站点：接口内站点为爬虫 jar 型（TVBox jar 引擎才能解析），JS 扩展无法使用。请换一个 api 为 http 直连地址的 TVBox 接口，或直接填影视 API 地址'
      );
    }
    return sites;
  }

  _enc(key, payload) {
    return 'v1://' + key + '/' + encodeURIComponent(String(payload));
  }

  _dec(url) {
    const m = String(url).match(/^v1:\/\/(S\d+)\/(.+)$/);
    if (!m) return null;
    try {
      return { key: m[1], payload: decodeURIComponent(m[2]) };
    } catch (e) {
      return { key: m[1], payload: m[2] };
    }
  }

  _apiUrl(api, params) {
    const sep = api.includes('?') ? '&' : '?';
    return api + sep + params;
  }

  _cleanDesc(s) {
    return String(s || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async _categoryList(site) {
    const data = await this._fetchJson(this._apiUrl(site.api, 'ac=list'));
    const cls = data && Array.isArray(data.class) ? data.class : [];
    return cls
      .filter((c) => c && c.type_id)
      .map((c) => ({ typeId: String(c.type_id), title: String(c.type_name || c.type_id) }));
  }

  async _listPage(site, params) {
    const data = await this._fetchJson(this._apiUrl(site.api, 'ac=detail&' + params));
    const list = data && Array.isArray(data.list) ? data.list : [];
    return list
      .filter((v) => v && v.vod_id)
      .map((v) => ({
        title: String(v.vod_name || ''),
        url: this._enc(site.key, 'id=' + v.vod_id),
        cover: String(v.vod_pic || ''),
        update: String(v.vod_remarks || ''),
      }));
  }

  // 首页：所有站点最新内容聚合；全部失败时抛出原因
  async latest(page) {
    const sites = await this._loadSites();
    const out = [];
    const errs = [];
    for (const site of sites) {
      try {
        const l = await this._listPage(site, 'pg=' + page);
        for (const it of l) out.push(it);
      } catch (e) {
        errs.push(site.name + ': ' + e.message);
      }
    }
    if (!out.length && errs.length) {
      throw new Error('所有数据源都获取不到内容：' + errs.join(' | '));
    }
    return out;
  }

  // 分类筛选器：值格式 "{站点key}|{type_id}"，空值 = 全部
  async createFilter(filter) {
    let sites;
    try {
      sites = await this._loadSites();
    } catch (e) {
      return {};
    }
    const options = { '': '全部' };
    for (const site of sites) {
      try {
        const cs = await this._categoryList(site);
        for (const c of cs) {
          options[site.key + '|' + c.typeId] = site.name + '·' + c.title;
        }
      } catch (e) {}
    }
    return {
      type: { title: '分类', min: 1, max: 1, default: '', options },
    };
  }

  async search(kw, page, filter) {
    const sites = await this._loadSites();
    const out = [];
    const kwStr = String(kw || '').trim();
    const errs = [];
    if (kwStr) {
      for (const site of sites) {
        try {
          const l = await this._listPage(site, 'wd=' + encodeURIComponent(kwStr) + '&pg=' + page);
          for (const it of l) out.push(it);
        } catch (e) {
          errs.push(site.name + ': ' + e.message);
        }
      }
      if (!out.length && errs.length) {
        throw new Error('搜索失败：' + errs.join(' | '));
      }
      return out;
    }
    // 无关键词：按筛选分类拉取
    let types = null;
    if (filter && filter.type && Array.isArray(filter.type)) {
      types = filter.type.filter((v) => v !== undefined && v !== null);
    }
    if (!types || !types.length || types[0] === '') {
      for (const site of sites) {
        try {
          const l = await this._listPage(site, 'pg=' + page);
          for (const it of l) out.push(it);
        } catch (e) {}
      }
      return out;
    }
    for (const tv of types) {
      const m = String(tv).match(/^(S\d+)\|(.+)$/);
      if (!m) continue;
      const site = sites.find((s) => s.key === m[1]);
      if (!site) continue;
      try {
        const l = await this._listPage(site, 't=' + m[2] + '&pg=' + page);
        for (const it of l) out.push(it);
      } catch (e) {}
    }
    return out;
  }

  async detail(url) {
    const sites = await this._loadSites();
    const d = this._dec(url);
    if (!d) throw new Error('无效的条目链接');
    const site = sites.find((s) => s.key === d.key);
    if (!site) throw new Error('未找到对应数据源');
    const data = await this._fetchJson(this._apiUrl(site.api, 'ac=detail&ids=' + d.payload.split('=')[1]));
    const v = data && Array.isArray(data.list) ? data.list[0] : null;
    if (!v) throw new Error('未获取到详情');
    const playUrl = String(v.vod_play_url || '');
    const playFrom = String(v.vod_play_from || '');
    const groups = playUrl.split('$$$');
    const froms = playFrom.split('$$$');
    const episodes = groups
      .map((g, gi) => {
        const eps = g
          .split('#')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((ep) => {
            const i = ep.indexOf('$');
            const name = i >= 0 ? ep.slice(0, i) : ep;
            const u = i >= 0 ? ep.slice(i + 1) : '';
            return { name: String(name || u), url: u ? this._enc(site.key, u) : '' };
          })
          .filter((ep) => ep.url);
        if (!eps.length) return null;
        return { title: String(froms[gi] || '播放源' + (gi + 1)), urls: eps };
      })
      .filter(Boolean);
    return {
      title: String(v.vod_name || ''),
      cover: String(v.vod_pic || ''),
      desc: this._cleanDesc(v.vod_content || v.vod_remarks || ''),
      episodes: episodes.length ? episodes : [{ title: '播放', urls: [] }],
    };
  }

  async watch(url) {
    const d = this._dec(url);
    if (!d || !d.payload) throw new Error('无效的播放链接');
    const headers = { 'User-Agent': String((await this.getSetting('ua')) || 'okhttp/3.12.1') };
    const referer = String((await this.getSetting('referer')) || '').trim();
    if (referer) headers['Referer'] = referer;
    const type = /\.m3u8(\?|$)/i.test(d.payload) ? 'hls' : 'mp4';
    return { type, url: d.payload, headers };
  }
}
