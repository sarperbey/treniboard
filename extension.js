import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

const BASE = 'http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/';
const MAX_ROWS = 8;
const MIN_REFRESH_MS = 15000;
const DEFAULT_QUERY = 'Roma Termini';
const CONFIG_PATH = GLib.build_filenamev([GLib.get_user_config_dir(), 'treniboard-gnome.json']);

const GREEN = '#3ddc84';
const AMBER = '#ffb020';
const RED = '#ff5d5d';

function hm(ms) {
    return new Date(ms).toLocaleTimeString('it-IT', {hour: '2-digit', minute: '2-digit'});
}

function dateParam() {
    return encodeURIComponent(new Date().toString().replace(/\s*\(.*\)$/, ''));
}

function titleCase(s) {
    return s.toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase());
}

function parseStations(text) {
    return text.split('\n')
        .map(l => l.trim())
        .filter(l => l.includes('|'))
        .map(l => {
            const i = l.lastIndexOf('|');
            return {name: titleCase(l.slice(0, i)), code: l.slice(i + 1).trim()};
        });
}

function loadConfig() {
    try {
        const [ok, bytes] = GLib.file_get_contents(CONFIG_PATH);
        if (ok) {
            const c = JSON.parse(new TextDecoder().decode(bytes));
            if (c.code && c.name)
                return c;
        }
    } catch (_e) {
        // nessuna configurazione salvata
    }
    return null;
}

function saveConfig(station) {
    try {
        GLib.file_set_contents(CONFIG_PATH, new TextEncoder().encode(JSON.stringify(station)));
    } catch (e) {
        console.error(`Treniboard: salvataggio non riuscito: ${e.message}`);
    }
}

function statusOf(t) {
    const late = t.ritardo || 0;
    if (t.circolante === false && !late)
        return ['Soppresso', RED];
    if (late > 0)
        return [`+${late} min`, late >= 15 ? RED : AMBER];
    return ['In orario', GREEN];
}

const TrenoIndicator = GObject.registerClass(
class TrenoIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Treniboard');

        this._session = new Soup.Session({timeout: 15});
        this._cancellable = new Gio.Cancellable();
        this._station = loadConfig();
        this._gen = 0;
        this._busy = false;
        this._last = 0;
        this._searchId = 0;
        this._arrCache = new Map();

        this._label = new St.Label({text: '🚆', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._label);

        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._stationLabel = new St.Label({
            text: 'Treniboard',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-weight: bold;',
        });
        const refreshBtn = new St.Button({
            style_class: 'button',
            can_focus: true,
            child: new St.Icon({icon_name: 'view-refresh-symbolic', style_class: 'popup-menu-icon'}),
        });
        refreshBtn.connect('clicked', () => this._refresh(true));
        header.add_child(this._stationLabel);
        header.add_child(refreshBtn);
        this.menu.addMenuItem(header);

        this._list = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._list);

        this._updated = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        this._updated.label.style = 'font-size: 0.85em;';
        this.menu.addMenuItem(this._updated);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const searchItem = new PopupMenu.PopupSubMenuMenuItem('Cambia stazione');
        this.menu.addMenuItem(searchItem);

        const entryItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._entry = new St.Entry({hint_text: 'Cerca stazione…', can_focus: true, x_expand: true});
        entryItem.add_child(this._entry);
        searchItem.menu.addMenuItem(entryItem);

        this._results = new PopupMenu.PopupMenuSection();
        searchItem.menu.addMenuItem(this._results);

        this._entry.clutter_text.connect('text-changed', () => this._onSearchText());
        searchItem.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._entry.grab_key_focus();
        });
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._refresh(false);
        });

        this._refresh(true);
    }

    async _get(url) {
        const msg = Soup.Message.new('GET', url);
        msg.get_request_headers().append('User-Agent', 'Mozilla/5.0');
        const bytes = await this._session.send_and_read_async(
            msg, GLib.PRIORITY_DEFAULT, this._cancellable);
        if (msg.get_status() !== Soup.Status.OK)
            throw new Error(`HTTP ${msg.get_status()}`);
        return new TextDecoder().decode(bytes.get_data());
    }

    _addInfo(section, text) {
        section.addMenuItem(new PopupMenu.PopupMenuItem(text, {reactive: false, can_focus: false}));
    }

    _onSearchText() {
        if (this._searchId) {
            GLib.Source.remove(this._searchId);
            this._searchId = 0;
        }
        const q = this._entry.get_text().trim();
        if (q.length < 2) {
            this._results.removeAll();
            return;
        }
        this._searchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._searchId = 0;
            this._doSearch(q);
            return GLib.SOURCE_REMOVE;
        });
    }

    async _doSearch(q) {
        try {
            const list = parseStations(
                await this._get(`${BASE}autocompletaStazione/${encodeURIComponent(q)}`));
            if (this._cancellable.is_cancelled())
                return;
            this._results.removeAll();
            if (!list.length) {
                this._addInfo(this._results, 'Nessuna stazione trovata');
                return;
            }
            for (const s of list.slice(0, 6)) {
                const item = new PopupMenu.PopupMenuItem(s.name);
                item.connect('activate', () => this._setStation(s));
                this._results.addMenuItem(item);
            }
        } catch (_e) {
            if (this._cancellable.is_cancelled())
                return;
            this._results.removeAll();
            this._addInfo(this._results, 'Ricerca non riuscita');
        }
    }

    _setStation(station) {
        this._station = station;
        saveConfig(station);
        this._entry.set_text('');
        this._results.removeAll();
        this._arrCache.clear();
        this._refresh(true);
    }

    async _resolveDefault() {
        const list = parseStations(
            await this._get(`${BASE}autocompletaStazione/${encodeURIComponent(DEFAULT_QUERY)}`));
        if (!list.length)
            throw new Error('Stazione non trovata');
        this._station = list.find(s => s.name.toLowerCase() === DEFAULT_QUERY.toLowerCase()) ?? list[0];
        saveConfig(this._station);
    }

    async _refresh(force) {
        if (this._busy)
            return;
        if (!force && Date.now() - this._last < MIN_REFRESH_MS)
            return;
        this._busy = true;
        try {
            if (!this._station)
                await this._resolveDefault();
            if (this._cancellable.is_cancelled())
                return;
            this._stationLabel.text = this._station.name;

            const text = await this._get(
                `${BASE}partenze/${this._station.code}/${dateParam()}`);
            if (this._cancellable.is_cancelled())
                return;
            const rows = text.trim() ? JSON.parse(text) : [];
            rows.sort((a, b) => a.orarioPartenza - b.orarioPartenza);
            this._render(rows.slice(0, MAX_ROWS));
            this._last = Date.now();
            this._updated.label.text = `Aggiornato alle ${hm(Date.now())}`;
        } catch (_e) {
            if (this._cancellable.is_cancelled())
                return;
            this._list.removeAll();
            this._addInfo(this._list, 'Impossibile caricare i dati');
            this._label.text = '🚆';
        } finally {
            this._busy = false;
        }
    }

    _render(rows) {
        this._gen++;
        const gen = this._gen;
        if (this._arrCache.size > 100)
            this._arrCache.clear();
        this._list.removeAll();

        if (!rows.length) {
            this._addInfo(this._list, 'Nessun treno in partenza');
            this._label.text = '🚆';
            return;
        }
        this._label.text = `🚆 ${hm(rows[0].orarioPartenza)}`;

        for (const t of rows) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});

            const time = new St.Label({
                text: hm(t.orarioPartenza),
                style: 'font-weight: bold; min-width: 3.4em;',
                y_align: Clutter.ActorAlign.CENTER,
            });

            const platform = (t.binarioEffettivoPartenzaDescrizione ||
                t.binarioProgrammatoPartenzaDescrizione || '').trim() || '–';
            const mid = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
            mid.add_child(new St.Label({text: t.destinazione}));
            mid.add_child(new St.Label({
                text: `${t.compNumeroTreno || t.numeroTreno} · binario ${platform}`,
                style: 'font-size: 0.85em; color: #9aa5b8;',
            }));

            const [statText, statColor] = statusOf(t);
            const right = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
            const arr = new St.Label({
                text: 'arr. …',
                x_align: Clutter.ActorAlign.END,
                style: 'font-size: 0.9em;',
            });
            right.add_child(arr);
            right.add_child(new St.Label({
                text: statText,
                x_align: Clutter.ActorAlign.END,
                style: `font-size: 0.85em; color: ${statColor};`,
            }));

            item.add_child(time);
            item.add_child(mid);
            item.add_child(right);
            this._list.addMenuItem(item);

            this._loadArrival(t, arr, gen).catch(() => {
                if (gen === this._gen && !this._cancellable.is_cancelled())
                    arr.text = 'arr. –';
            });
        }
    }

    async _loadArrival(t, label, gen) {
        const key = `${t.codOrigine}/${t.numeroTreno}/${t.dataPartenzaTreno}`;
        let v;
        const cached = this._arrCache.get(key);
        if (cached && Date.now() - cached.ts < 60000) {
            v = cached.v;
        } else {
            const d = JSON.parse(await this._get(`${BASE}andamentoTreno/${key}`));
            const stops = d.fermate || [];
            v = null;
            if (stops.length) {
                const last = stops[stops.length - 1];
                const teor = last.arrivo_teorico || last.programmata;
                const rit = last.ritardoArrivo || d.ritardo || 0;
                const arrMs = last.arrivoReale || (teor ? teor + rit * 60000 : null);
                if (arrMs)
                    v = {arr: arrMs, rit};
            }
            this._arrCache.set(key, {ts: Date.now(), v});
        }
        if (gen !== this._gen)
            return;
        if (!v) {
            label.text = 'arr. –';
            return;
        }
        label.text = `arr. ${hm(v.arr)}`;
        if (v.rit > 0)
            label.style = `font-size: 0.9em; color: ${v.rit >= 15 ? RED : AMBER};`;
    }

    destroy() {
        this._cancellable.cancel();
        if (this._searchId) {
            GLib.Source.remove(this._searchId);
            this._searchId = 0;
        }
        this._session.abort();
        super.destroy();
    }
});

export default class TrenoBoardExtension extends Extension {
    enable() {
        this._indicator = new TrenoIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
