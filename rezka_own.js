(function () {
  'use strict';

  if (window.rezka_own_plugin) return;
  window.rezka_own_plugin = true;

  var VERSION = '1.0.0';
  var DEFAULT_HOST = 'https://rezka.fi';
  var logged = false;   // вход уже выполнен в этой сессии
  var pending = [];     // активные запросы (чтобы можно было отменить)

  /* ====================================================================
   *  Настройки / утилиты
   * ==================================================================== */

  function cfg(key, def) {
    var v = Lampa.Storage.get('rz_' + key, def === undefined ? '' : def);
    return typeof v === 'string' ? v.trim() : v;
  }

  function host() {
    var h = cfg('host', DEFAULT_HOST) || DEFAULT_HOST;
    if (!/^https?:\/\//i.test(h)) h = 'https://' + h;
    return h.replace(/\/+$/, '');
  }

  function proxify(url) {
    var p = cfg('proxy');
    return p ? p.replace('{url}', encodeURIComponent(url)) : url;
  }

  function form(obj) {
    var a = [];
    for (var k in obj) a.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
    return a.join('&');
  }

  function parseJson(text) {
    if (text && typeof text === 'object') return text;
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function unwrap(data) {
    if (typeof data === 'string') return data;
    if (data && data.currentTarget && typeof data.currentTarget.responseText === 'string') return data.currentTarget.responseText;
    try { return JSON.stringify(data); } catch (e) { return ''; }
  }

  // Разбор HTML без загрузки картинок и выполнения скриптов
  function dom(html) {
    var d = document.implementation.createHTMLDocument('');
    d.body.innerHTML = html || '';
    return d;
  }

  function qsa(root, sel) {
    return Array.prototype.slice.call(root.querySelectorAll(sel));
  }

  function abs(url) {
    if (/^https?:\/\//i.test(url)) return url;
    return host() + (url.charAt(0) === '/' ? '' : '/') + url;
  }

  function norm(s) {
    return (s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').replace(/^\s+|\s+$/g, '');
  }

  function abortAll() {
    pending.forEach(function (n) { try { n.clear(); } catch (e) {} });
    pending = [];
  }

  /* ====================================================================
   *  Сеть
   * ==================================================================== */

  function request(url, post, ok, fail, returnHeaders) {
    var net = new Lampa.Reguest();
    var headers = { 'X-Requested-With': 'XMLHttpRequest' };
    var cookie = cfg('cookie');

    if (cookie) headers['Cookie'] = cookie;
    if (post) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';

    pending.push(net);

    net['native'](proxify(url), function (data) {
      ok(unwrap(data), data);
    }, function (e) {
      if (fail) fail(e);
    }, post || false, {
      dataType: 'text',
      headers: headers,
      timeout: 15000,
      returnHeaders: !!returnHeaders
    });
  }

  // Пытаемся достать cookie из ответа (работает не на всех платформах)
  function grabCookies(obj) {
    var raw = '';
    try {
      var h = obj && (obj.headers || (obj.currentTarget && obj.currentTarget.headers));
      if (h) {
        raw = h['set-cookie'] || h['Set-Cookie'] || '';
        if (raw.join) raw = raw.join('\n');
      } else if (obj && obj.getResponseHeader) {
        raw = obj.getResponseHeader('set-cookie') || '';
      }
    } catch (e) {}

    var out = {}, m, re = /(dle_user_id|dle_password|PHPSESSID)=([^;,\s]+)/g;
    while ((m = re.exec(raw))) if (m[2] !== 'deleted') out[m[1]] = m[2];

    var parts = [];
    for (var k in out) parts.push(k + '=' + out[k]);
    return parts.join('; ');
  }

  /* ====================================================================
   *  Rezka: вход
   * ==================================================================== */

  function login(ok, fail) {
    var l = cfg('login'), p = cfg('password');
    if (!l || !p) return fail('Не указаны логин и пароль (Настройки → Rezka)');

    request(host() + '/ajax/login/', form({
      login_name: l,
      login_password: p,
      login_not_save: 0
    }), function (text, raw) {
      var j = parseJson(text);
      if (j && j.success) {
        var ck = grabCookies(raw);
        if (ck) Lampa.Storage.set('rz_cookie', ck);
        logged = true;
        ok();
      } else {
        fail((j && j.message) ? String(j.message).replace(/<[^>]+>/g, '') : 'Не удалось войти');
      }
    }, function () {
      fail('Нет связи с ' + host());
    }, true);
  }

  function ensureLogin(ok, fail) {
    if (logged) return ok();
    login(ok, function (err) {
      // если вход не удался, но есть сохранённый cookie — пробуем работать с ним
      if (cfg('cookie')) { logged = true; ok(); } else fail(err);
    });
  }

  /* ====================================================================
   *  Rezka: поиск
   * ==================================================================== */

  function search(query, ok, fail) {
    request(host() + '/search/?do=search&subaction=search&q=' + encodeURIComponent(query), false, function (html) {
      var doc = dom(html), list = [];

      qsa(doc, '.b-content__inline_item').forEach(function (el) {
        var a = el.querySelector('.b-content__inline_item-link a');
        var info = el.querySelector('.b-content__inline_item-link div');
        var url = el.getAttribute('data-url') || (a && a.getAttribute('href'));
        if (!a || !url) return;

        var infoText = info ? info.textContent.replace(/^\s+|\s+$/g, '') : '';
        var ym = infoText.match(/(\d{4})/);

        list.push({
          id: el.getAttribute('data-id') || '',
          url: abs(url),
          title: a.textContent.replace(/^\s+|\s+$/g, ''),
          year: ym ? ym[1] : '',
          info: infoText
        });
      });

      ok(list);
    }, fail);
  }

  function rank(list, q, year) {
    var nq = norm(q);
    list.forEach(function (i) {
      var nt = norm(i.title), s = 0;
      if (nt === nq) s += 2;
      else if (nt && nq && (nt.indexOf(nq) >= 0 || nq.indexOf(nt) >= 0)) s += 1;
      if (year && i.year) {
        if (i.year === year) s += 2;
        else if (Math.abs(parseInt(i.year, 10) - parseInt(year, 10)) === 1) s += 1;
      }
      i.score = s;
    });
    return list.sort(function (a, b) { return b.score - a.score; });
  }

  /* ====================================================================
   *  Rezka: расшифровка ссылок на потоки
   * ==================================================================== */

  var trashCodes = null;

  function buildTrash() {
    var chars = ['@', '#', '!', '^', '$'], codes = [];
    function comb(prefix, n) {
      if (n === 0) { codes.push(btoa(prefix)); return; }
      for (var i = 0; i < chars.length; i++) comb(prefix + chars[i], n - 1);
    }
    comb('', 2);
    comb('', 3);
    return codes;
  }

  function decodeStream(data) {
    if (!data) return '';
    if (/^\s*\[/.test(data)) return data; // уже открытый текст

    if (!trashCodes) trashCodes = buildTrash();

    var s = String(data).replace('#h', '').split('//_//').join('');
    trashCodes.forEach(function (c) { s = s.split(c).join(''); });

    s = s.replace(/=+$/, '');
    while (s.length % 4) s += '=';

    try { return atob(s); } catch (e) { return ''; }
  }

  function parseStreams(raw, subtitleRaw) {
    var text = decodeStream(raw), q = {};

    text.split(',').forEach(function (part) {
      var m = part.match(/^\s*\[([^\]]+)\](.+)$/);
      if (!m) return;
      var links = m[2].split(' or ');
      if (links[0]) q[m[1]] = links[0].replace(/^\s+|\s+$/g, '');
    });

    var keys = Object.keys(q).sort(function (a, b) {
      return (parseInt(b, 10) || 0) - (parseInt(a, 10) || 0) || b.length - a.length;
    });
    if (!keys.length) return null;

    var def = parseInt(Lampa.Storage.field('video_quality_default'), 10), pick = keys[0];
    keys.forEach(function (k) { if (parseInt(k, 10) === def) pick = k; });

    var subs = [];
    if (subtitleRaw && typeof subtitleRaw === 'string') {
      subtitleRaw.split(',').forEach(function (p) {
        var m = p.match(/^\s*\[([^\]]+)\](.+)$/);
        if (m) subs.push({ label: m[1], url: m[2] });
      });
    }

    return { url: q[pick], quality: q, subtitles: subs };
  }

  function getStream(el, ok, fail) {
    var body = { id: el.post, translator_id: el.tr.id };

    if (el.season) {
      body.action = 'get_stream';
      body.season = el.season;
      body.episode = el.episode;
    } else {
      body.action = 'get_movie';
      body.is_camrip = el.tr.camrip || 0;
      body.is_ads = el.tr.ads || 0;
      body.is_director = el.tr.director || 0;
    }

    request(host() + '/ajax/get_cdn_series/?t=' + Date.now(), form(body), function (text) {
      var j = parseJson(text);
      if (!j || !j.success || !j.url) return fail(j && j.message ? String(j.message).replace(/<[^>]+>/g, '') : '');
      var s = parseStreams(j.url, j.subtitle);
      if (s) ok(s); else fail('');
    }, function () { fail(''); });
  }

  /* ====================================================================
   *  Запоминание выбора (озвучка / сезон)
   * ==================================================================== */

  function getChoice(id) {
    var all = Lampa.Storage.get('rz_choice', '{}');
    if (typeof all === 'string') { try { all = JSON.parse(all); } catch (e) { all = {}; } }
    return (all && all[id]) || {};
  }

  function saveChoice(id, data) {
    var all = Lampa.Storage.get('rz_choice', '{}');
    if (typeof all === 'string') { try { all = JSON.parse(all); } catch (e) { all = {}; } }
    all = all || {};
    all[id] = all[id] || {};
    for (var k in data) all[id][k] = data[k];
    Lampa.Storage.set('rz_choice', all);
  }

  /* ====================================================================
   *  Компонент (экран со списком)
   * ==================================================================== */

  function component(object) {
    var scroll = new Lampa.Scroll({ mask: true, over: true });
    var files = new Lampa.Explorer(object);
    var filter = new Lampa.Filter(object);
    var movie = object.movie;
    var last, initialized;
    var st = { post: '', serial: false, voices: [], voice: 0, seasons: [], episodes: [], season: 1 };

    this.initialize = function () {
      var _this = this;

      this.loading(true);

      filter.onBack = function () { _this.start(); };
      filter.onSelect = function (type, a, b) {
        if (type !== 'filter') return;
        if (a.stype === 'voice') {
          st.voice = b.index;
          Lampa.Select.close();
          _this.reset();
          _this.onVoice();
        } else if (a.stype === 'season') {
          st.season = st.seasons[b.index].id;
          saveChoice(movie.id, { season: st.season });
          Lampa.Select.close();
          _this.showEpisodes();
        }
      };

      filter.render().find('.filter--search, .filter--sort').addClass('hide');
      if (filter.addButtonBack) filter.addButtonBack();

      scroll.body().addClass('torrent-list');
      files.appendFiles(scroll.render());
      files.appendHead(filter.render());
      scroll.minus(files.render().find('.explorer__files-head'));
      scroll.body().append(Lampa.Template.get('rz_loading'));

      Lampa.Controller.enable('content');
      this.loading(false);

      this.begin();
    };

    this.begin = function () {
      var _this = this;
      ensureLogin(function () { _this.find(); }, function (err) {
        _this.message('Rezka: ошибка входа', err);
      });
    };

    this.find = function (useOriginal) {
      var _this = this;
      var q = useOriginal ? (movie.original_title || movie.original_name) : (movie.title || movie.name);
      var year = ((movie.release_date || movie.first_air_date || '') + '').slice(0, 4);

      search(q, function (list) {
        if (!list.length) {
          if (!useOriginal && (movie.original_title || movie.original_name)) return _this.find(true);
          return _this.empty();
        }
        list = rank(list, q, year);
        if (list.length === 1 || (list[0].score >= 4 && (!list[1] || list[1].score < list[0].score))) _this.open(list[0]);
        else _this.similars(list.slice(0, 20));
      }, function () {
        _this.message('Ошибка сети', 'Не удалось выполнить поиск на ' + host());
      });
    };

    this.similars = function (list) {
      var _this = this;
      scroll.clear();
      this.activity.loader(false);

      list.forEach(function (it) {
        var html = Lampa.Template.get('rz_folder', { title: it.title, info: it.info });
        html.on('hover:enter', function () { _this.open(it); })
          .on('hover:focus', function (e) { last = e.target; scroll.update($(e.target), true); });
        scroll.append(html);
      });

      Lampa.Controller.enable('content');
    };

    this.open = function (item) {
      var _this = this;
      this.reset();

      request(item.url, false, function (html) {
        if (!_this.parsePage(html, item)) {
          return _this.message('Не найдено', 'Не удалось прочитать страницу (изменилась разметка или нет доступа).');
        }
        _this.onVoice();
      }, function () {
        _this.message('Ошибка сети', 'Не удалось открыть страницу на ' + host());
      });
    };

    this.parsePage = function (html, item) {
      var doc = dom(html);
      var m = html.match(/initCDN(Movies|Series)Events\(\s*(\d+)\s*,\s*(\d+)/);
      var flags = html.match(/initCDNMoviesEvents\(\s*\d+\s*,\s*\d+\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);

      st.serial = m ? m[1] === 'Series' : !!movie.name;
      st.post = m ? m[2] : item.id;
      st.voices = [];
      st.voice = 0;

      var active = -1;
      qsa(doc, '.b-translator__item').forEach(function (el, i) {
        st.voices.push({
          id: el.getAttribute('data-translator_id'),
          title: el.textContent.replace(/^\s+|\s+$/g, '') || el.getAttribute('title') || ('Озвучка ' + (i + 1)),
          camrip: el.getAttribute('data-camrip') || 0,
          ads: el.getAttribute('data-ads') || 0,
          director: el.getAttribute('data-director') || 0
        });
        if (/\bactive\b/.test(el.className)) active = i;
      });

      if (!st.voices.length && m) {
        st.voices.push({
          id: m[3],
          title: 'Стандартная',
          camrip: flags ? flags[1] : 0,
          ads: flags ? flags[2] : 0,
          director: flags ? flags[3] : 0
        });
      }

      if (!st.post || !st.voices.length) return false;

      var ch = getChoice(movie.id);
      if (active >= 0) st.voice = active;
      st.voices.forEach(function (v, i) { if (ch.voice && v.title === ch.voice) st.voice = i; });
      if (ch.season) st.season = ch.season;

      return true;
    };

    this.onVoice = function () {
      var v = st.voices[st.voice];
      saveChoice(movie.id, { voice: v.title });

      if (st.serial) return this.loadEpisodes();

      this.buildFilter();
      this.display([{
        title: movie.title || movie.name,
        info: v.title,
        voice_name: v.title,
        tr: v,
        post: st.post
      }]);
    };

    this.loadEpisodes = function () {
      var _this = this;
      var v = st.voices[st.voice];

      request(host() + '/ajax/get_cdn_series/?t=' + Date.now(), form({
        id: st.post,
        translator_id: v.id,
        action: 'get_episodes'
      }), function (text) {
        var j = parseJson(text);
        if (!j || !j.success) return _this.message('Нет серий', (j && j.message) ? String(j.message).replace(/<[^>]+>/g, '') : 'Rezka не вернул список серий');

        st.episodes = qsa(dom(j.episodes), '.b-simple_episode__item').map(function (el) {
          return {
            season: parseInt(el.getAttribute('data-season_id'), 10),
            episode: parseInt(el.getAttribute('data-episode_id'), 10),
            title: el.textContent.replace(/^\s+|\s+$/g, '')
          };
        });

        st.seasons = qsa(dom(j.seasons), '.b-simple_season__item').map(function (el) {
          return { id: parseInt(el.getAttribute('data-tab_id'), 10), title: el.textContent.replace(/^\s+|\s+$/g, '') };
        });

        if (!st.seasons.length) {
          var seen = {};
          st.episodes.forEach(function (e) {
            if (!seen[e.season]) { seen[e.season] = 1; st.seasons.push({ id: e.season, title: 'Сезон ' + e.season }); }
          });
        }

        var ok = st.seasons.some(function (s) { return s.id === st.season; });
        if (!ok && st.seasons.length) st.season = st.seasons[0].id;

        _this.showEpisodes();
      }, function () {
        _this.message('Ошибка сети', 'Не удалось получить список серий');
      });
    };

    this.showEpisodes = function () {
      var v = st.voices[st.voice];
      var items = st.episodes.filter(function (e) { return e.season === st.season; }).map(function (e) {
        return {
          title: e.title || ('Серия ' + e.episode),
          season: e.season,
          episode: e.episode,
          info: v.title,
          voice_name: v.title,
          tr: v,
          post: st.post
        };
      });

      this.reset();
      this.buildFilter();
      if (!items.length) return this.empty();
      this.display(items);
    };

    this.buildFilter = function () {
      var select = [], chosen = [];
      var v = st.voices[st.voice];

      select.push({
        title: 'Озвучка',
        subtitle: v ? v.title : '',
        items: st.voices.map(function (x, i) { return { title: x.title, selected: i === st.voice, index: i }; }),
        stype: 'voice'
      });
      chosen.push('Озвучка: ' + (v ? v.title : ''));

      if (st.serial && st.seasons.length) {
        select.push({
          title: 'Сезон',
          subtitle: 'Сезон ' + st.season,
          items: st.seasons.map(function (s, i) { return { title: s.title, selected: s.id === st.season, index: i }; }),
          stype: 'season'
        });
        chosen.push('Сезон: ' + st.season);
      }

      filter.set('filter', select);
      filter.chosen('filter', chosen);
    };

    this.display = function (items) {
      var _this = this;
      scroll.clear();
      scroll.reset();
      this.activity.loader(false);

      items.forEach(function (el) {
        var hash = Lampa.Utils.hash(el.season
          ? [el.season, el.season > 10 ? ':' : '', el.episode, movie.original_title].join('')
          : movie.original_title);

        el.timeline = Lampa.Timeline.view(hash);

        var html = Lampa.Template.get('rz_item', { title: el.title, time: '', info: el.info, quality: '' });
        html.find('.online-prestige__timeline').append(Lampa.Timeline.render(el.timeline));

        html.on('hover:enter', function () {
          if (movie.id) Lampa.Favorite.add('history', movie, 100);
          _this.play(el, items);
        }).on('hover:focus', function (e) {
          last = e.target;
          scroll.update($(e.target), true);
        });

        scroll.append(html);
      });

      Lampa.Controller.enable('content');
    };

    this.toPlay = function (el) {
      return {
        title: el.title,
        url: '',
        quality: '',
        timeline: el.timeline,
        season: el.season,
        episode: el.episode,
        voice_name: el.voice_name,
        subtitles: []
      };
    };

    this.play = function (el, list) {
      var _this = this;

      Lampa.Loading.start(function () {
        Lampa.Loading.stop();
        abortAll();
        Lampa.Controller.toggle('content');
      });

      getStream(el, function (s) {
        Lampa.Loading.stop();

        var first = _this.toPlay(el);
        first.url = s.url;
        first.quality = s.quality;
        first.subtitles = s.subtitles;
        first.isonline = true;

        var playlist = [];

        if (el.season && Lampa.Storage.field('player') === 'inner') {
          list.forEach(function (e) {
            if (e === el) return playlist.push(first);

            var cell = _this.toPlay(e);
            cell.url = function (call) {
              getStream(e, function (s2) {
                cell.url = s2.url;
                cell.quality = s2.quality;
                cell.subtitles = s2.subtitles;
                call();
              }, function () {
                cell.url = '';
                Lampa.Noty.show('Не удалось получить ссылку');
                call();
              });
            };
            playlist.push(cell);
          });
        } else {
          playlist.push(first);
        }

        if (playlist.length > 1) first.playlist = playlist;

        Lampa.Player.play(first);
        Lampa.Player.playlist(playlist);
      }, function (msg) {
        Lampa.Loading.stop();
        Lampa.Noty.show(msg || 'Не удалось получить ссылку');
      });
    };

    this.message = function (title, text) {
      var html = $('<div class="online-empty"><div class="online-empty__title"></div><div class="online-empty__time"></div></div>');
      html.find('.online-empty__title').text(title);
      html.find('.online-empty__time').text(text || '');
      scroll.clear();
      scroll.append(html);
      this.loading(false);
    };

    this.empty = function () {
      this.message('Ничего не найдено', 'Поиск на Rezka не дал результатов');
    };

    this.reset = function () {
      last = false;
      abortAll();
      scroll.render().find('.empty').remove();
      scroll.clear();
      scroll.reset();
      scroll.body().append(Lampa.Template.get('rz_loading'));
    };

    this.loading = function (status) {
      if (status) this.activity.loader(true);
      else {
        this.activity.loader(false);
        this.activity.toggle();
      }
    };

    this.create = function () { return this.render(); };
    this.render = function () { return files.render(); };
    this.back = function () { Lampa.Activity.backward(); };
    this.pause = function () {};
    this.stop = function () {};

    this.start = function () {
      if (Lampa.Activity.active().activity !== this.activity) return;

      if (!initialized) {
        initialized = true;
        this.initialize();
      }

      Lampa.Background.immediately(Lampa.Utils.cardImgBackgroundBlur(movie));

      Lampa.Controller.add('content', {
        toggle: function () {
          Lampa.Controller.collectionSet(scroll.render(), files.render());
          Lampa.Controller.collectionFocus(last || false, scroll.render());
        },
        up: function () {
          if (Navigator.canmove('up')) Navigator.move('up');
          else Lampa.Controller.toggle('head');
        },
        down: function () { Navigator.move('down'); },
        right: function () {
          if (Navigator.canmove('right')) Navigator.move('right');
          else filter.show('Фильтр', 'filter');
        },
        left: function () {
          if (Navigator.canmove('left')) Navigator.move('left');
          else Lampa.Controller.toggle('menu');
        },
        back: this.back.bind(this)
      });

      Lampa.Controller.toggle('content');
    };

    this.destroy = function () {
      abortAll();
      files.destroy();
      scroll.destroy();
    };
  }

  /* ====================================================================
   *  Запуск: стили, шаблоны, кнопка, настройки
   * ==================================================================== */

  function openFor(movie) {
    Lampa.Component.add('rezka_online', component);
    Lampa.Activity.push({
      url: '',
      title: 'Rezka',
      component: 'rezka_online',
      search: movie.title || movie.name,
      movie: movie,
      page: 1
    });
  }

  function addSettings() {
    Lampa.SettingsApi.addComponent({
      component: 'rezka_own',
      name: 'Rezka',
      icon: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M10 8l6 4-6 4V8z" fill="currentColor"/></svg>'
    });

    Lampa.SettingsApi.addParam({
      component: 'rezka_own',
      param: { name: 'rz_host', type: 'input', values: '', 'default': DEFAULT_HOST, placeholder: DEFAULT_HOST },
      field: { name: 'Адрес сайта (зеркало)', description: 'Например https://rezka.ag — если домен сменился, укажите рабочее зеркало' }
    });

    Lampa.SettingsApi.addParam({
      component: 'rezka_own',
      param: { name: 'rz_login', type: 'input', values: '', 'default': '', placeholder: 'логин или e-mail' },
      field: { name: 'Логин', description: 'Логин от вашего аккаунта Rezka' },
      onChange: function () { logged = false; }
    });

    Lampa.SettingsApi.addParam({
      component: 'rezka_own',
      param: { name: 'rz_password', type: 'input', values: '', 'default': '', placeholder: 'пароль' },
      field: { name: 'Пароль', description: 'Пароль от вашего аккаунта Rezka' },
      onChange: function () { logged = false; }
    });

    Lampa.SettingsApi.addParam({
      component: 'rezka_own',
      param: { name: 'rz_check', type: 'button' },
      field: { name: 'Войти / проверить вход', description: 'Выполнить вход с указанными данными' },
      onChange: function () {
        logged = false;
        Lampa.Noty.show('Rezka: выполняю вход…');
        login(function () {
          Lampa.Noty.show('Rezka: вход выполнен' + (cfg('cookie') ? '' : ' (cookie не получены, см. поле «Cookie»)'));
        }, function (err) {
          Lampa.Noty.show('Rezka: ' + err);
        });
      }
    });

    Lampa.SettingsApi.addParam({
      component: 'rezka_own',
      param: { name: 'rz_cookie', type: 'input', values: '', 'default': '', placeholder: 'dle_user_id=...; dle_password=...' },
      field: { name: 'Cookie (необязательно)', description: 'Заполняется автоматически после входа. Можно вставить вручную dle_user_id и dle_password из браузера' }
    });

    Lampa.SettingsApi.addParam({
      component: 'rezka_own',
      param: { name: 'rz_proxy', type: 'input', values: '', 'default': '', placeholder: 'https://my.proxy/?u={url}' },
      field: { name: 'Прокси (необязательно)', description: 'Шаблон адреса прокси, {url} будет заменён на адрес запроса. Нужен, если сайт блокирует запросы из Lampa (CORS)' }
    });
  }

  function start() {
    Lampa.Template.add('rezka_css', '<style>' +
      '.online-prestige{position:relative;border-radius:.3em;background-color:rgba(0,0,0,.3);display:flex}' +
      '.online-prestige__body{padding:1.2em;line-height:1.3;flex-grow:1;position:relative}' +
      '.online-prestige__folder{padding:1em;flex-shrink:0}' +
      '.online-prestige__folder>svg{width:4.4em!important;height:4.4em!important}' +
      '.online-prestige__head,.online-prestige__footer{display:flex;justify-content:space-between;align-items:center}' +
      '.online-prestige__timeline{margin:.8em 0}' +
      '.online-prestige__timeline>.time-line{display:block!important}' +
      '.online-prestige__title{font-size:1.7em;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical}' +
      '.online-prestige__time{padding-left:2em}' +
      '.online-prestige__info{display:flex;align-items:center}' +
      '.online-prestige__quality{padding-left:1em;white-space:nowrap}' +
      '.online-prestige.focus::after{content:"";position:absolute;top:-.6em;left:-.6em;right:-.6em;bottom:-.6em;border-radius:.7em;border:solid .3em #fff;z-index:-1;pointer-events:none}' +
      '.online-prestige+.online-prestige{margin-top:1.5em}' +
      '.online-empty{line-height:1.4}' +
      '.online-empty__title{font-size:1.8em;margin-bottom:.3em}' +
      '.online-empty__time{font-size:1.2em;font-weight:300;margin-bottom:1.6em}' +
      '</style>');
    $('body').append(Lampa.Template.get('rezka_css', {}, true));

    Lampa.Template.add('rz_item',
      '<div class="online-prestige online-prestige--full selector">' +
        '<div class="online-prestige__body">' +
          '<div class="online-prestige__head"><div class="online-prestige__title">{title}</div><div class="online-prestige__time">{time}</div></div>' +
          '<div class="online-prestige__timeline"></div>' +
          '<div class="online-prestige__footer"><div class="online-prestige__info">{info}</div><div class="online-prestige__quality">{quality}</div></div>' +
        '</div>' +
      '</div>');

    Lampa.Template.add('rz_folder',
      '<div class="online-prestige online-prestige--folder selector">' +
        '<div class="online-prestige__folder">' +
          '<svg viewBox="0 0 128 112" fill="none" xmlns="http://www.w3.org/2000/svg">' +
            '<rect y="20" width="128" height="92" rx="13" fill="white"></rect>' +
            '<path d="M29.9963 8H98.0037C96.0446 3.3021 91.4079 0 86 0H42C36.5921 0 31.9555 3.3021 29.9963 8Z" fill="white" fill-opacity="0.23"></path>' +
            '<rect x="11" y="8" width="106" height="76" rx="13" fill="white" fill-opacity="0.51"></rect>' +
          '</svg>' +
        '</div>' +
        '<div class="online-prestige__body">' +
          '<div class="online-prestige__head"><div class="online-prestige__title">{title}</div></div>' +
          '<div class="online-prestige__footer"><div class="online-prestige__info">{info}</div></div>' +
        '</div>' +
      '</div>');

    Lampa.Template.add('rz_loading',
      '<div class="online-empty"><div class="broadcast__scan"><div></div></div></div>');

    Lampa.Component.add('rezka_online', component);
    addSettings();

    var buttonHtml =
      '<div class="full-start__button selector view--rezka" data-subtitle="Rezka v' + VERSION + '">' +
        '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
          '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>' +
          '<path d="M10 8l6 4-6 4V8z" fill="currentColor"/>' +
        '</svg>' +
        '<span>Rezka</span>' +
      '</div>';

    function addButton(e) {
      if (e.render.find('.view--rezka').length) return;
      var btn = $(buttonHtml);
      btn.on('hover:enter', function () { openFor(e.movie); });
      e.render.after(btn);
    }

    Lampa.Listener.follow('full', function (e) {
      if (e.type == 'complite') {
        addButton({
          render: e.object.activity.render().find('.view--torrent'),
          movie: e.data.movie
        });
      }
    });

    try {
      if (Lampa.Activity.active().component == 'full') {
        addButton({
          render: Lampa.Activity.active().activity.render().find('.view--torrent'),
          movie: Lampa.Activity.active().card
        });
      }
    } catch (e) {}
  }

  if (window.appready) start();
  else {
    Lampa.Listener.follow('app', function (e) {
      if (e.type == 'ready') start();
    });
  }
})();