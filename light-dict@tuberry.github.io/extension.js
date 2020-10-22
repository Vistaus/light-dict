// vim:fdm=syntax
// by: tuberry@gtihub
'use strict';

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const BoxPointer = imports.ui.boxpointer;
const Keyboard = imports.ui.status.keyboard;
const { Meta, Shell, Clutter, IBus, Gio, GLib, GObject, St, Pango, Gdk } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const gsettings = ExtensionUtils.getSettings();
const Fields = Me.imports.prefs.Fields;
const _ = imports.gettext.domain(Me.metadata['gettext-domain']).gettext;
const getIcon = x => Me.dir.get_child('icons').get_child(x + '-symbolic.svg').get_path();

const TRIGGER = { BOX: 0, BAR: 1, NIL: 2 }
const LOGSLEVEL = { NEVER: 0, CLICK: 1, HOVER: 2, ALWAYS: 3 };
const MODIFIERS = Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SHIFT_MASK;
const DBUSINTERFACE = `
<node>
    <interface name="org.gnome.Shell.Extensions.LightDict">
        <method name="LookUp">
            <arg type="s" direction="in" name="word"/>
        </method>
        <method name="ShowBar">
            <arg type="s" direction="in" name="word"/>
        </method>
    </interface>
</node>`;

const DictBar = GObject.registerClass({
    Signals: {
        'iconbar-signals': { param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING] },
    },
}, class DictBar extends BoxPointer.BoxPointer {
    _init() {
        super._init(St.Side.BOTTOM);
        this.style_class = 'light-dict-bar-boxpointer';
        Main.layoutManager.addTopChrome(this);

        this._pages = 1;
        this._pageIndex = 1;

        this._buildWidget();
        this._fetchSettings();
        this._loadSettings();
    }

    _buildWidget() {
        this._box = new St.BoxLayout({
            visible: false,
            reactive: true,
            vertical: false,
            style_class: 'light-dict-iconbox',
        });
        this.bin.set_child(this._box);
    }

    _fetchSettings() {
        this._xoffset   = gsettings.get_int(Fields.XOFFSET);
        this._bcommands = gsettings.get_strv(Fields.BCOMMANDS);
        this._tooltips  = gsettings.get_boolean(Fields.TOOLTIPS);
    }

    _loadSettings() {
        this._leaveID = this._box.connect('leave-event', this._onLeave.bind(this));
        this._enterID = this._box.connect('enter-event', this._onEnter.bind(this));
        this._scrollID = this._box.connect('scroll-event', this._onScroll.bind(this));

        this._xoffsetGId_  = gsettings.connect('changed::' + Fields.XOFFSET, () => { this._xoffset = gsettings.get_int(Fields.XOFFSET); });
        this._bcommandsId_ = gsettings.connect('changed::' + Fields.BCOMMANDS, () => { this._bcommands = gsettings.get_strv(Fields.BCOMMANDS); });
        this._tooltipsId_  = gsettings.connect('changed::' + Fields.TOOLTIPS, () => { this._tooltips = gsettings.get_boolean(Fields.TOOLTIPS); });
    }

    set _bcommands(commands) {
        this._pageIndex = 1;
        this._box.remove_all_children();
        commands.forEach(x => this._iconMaker(x));
    }

    set _xoffset(offset) {
        this.set_style('-arrow-border-radius: %dpx;'.format(-offset));
    }

    set _tooltips(tooltips) {
        if(tooltips) {
            if(this._iconTooltips) return;
            this._iconTooltips = new St.Label({
                visible: false,
                style_class: 'light-dict-tooltips',
            });
            Main.layoutManager.addTopChrome(this._iconTooltips);
        } else {
            if(!this._iconTooltips) return;
            this._iconTooltips.destroy();
            this._iconTooltips = null;
        }
    }

    get _tooltips() {
        return gsettings.get_boolean(Fields.TOOLTIPS);
    }

    get _autohide() {
        return gsettings.get_uint(Fields.AUTOHIDE);
    }

    get _pagesize() {
        return gsettings.get_uint(Fields.PAGESIZE);
    }

    get _iconsBox() {
        return this._box.get_children();
    }

    _onScroll(actor, event) {
        if(this._tooltips) this._iconTooltips.hide();
        this._iconsBox.forEach(x => x.entered = false);
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP: this._pageIndex--; break;
        case Clutter.ScrollDirection.DOWN: this._pageIndex++; break;
        }
        this._updatePages();
    }

    _onLeave(actor, event) {
        // let [px, py] = this.get_position(); //NOTE: get invalid position [0, 0]
        this._hide();
    }

    _onEnter() {
        if(this._delayID)
            GLib.source_remove(this._delayID), this._delayID = 0;
        this._box.visible = true;
    }

    _updatePages() {
        this._iconsBox.forEach(x => x.visible = x._visible);
        if(this._pagesize === 0) return;
        let visibleBox = this._iconsBox.filter(x => x._visible);
        this._pages = Math.ceil(visibleBox.length / this._pagesize);
        if(this._pages === 1 || this._pages === 0) return;
        this._pageIndex = this._pageIndex < 1 ? this._pages : (this._pageIndex > this._pages ? 1 : this._pageIndex);
        if(this._pageIndex === this._pages && visibleBox.length % this._pagesize) {
            visibleBox.forEach((x, i) => { x.visible = i >= visibleBox.length - this._pagesize && i < visibleBox.length; });
        } else {
            visibleBox.forEach((x, i) => { x.visible = i >= (this._pageIndex - 1)*this._pagesize && i < this._pageIndex*this._pagesize; });
        }
    }

    _updateVisible(fw, text) {
        this._iconsBox.forEach(x => {
            switch((x.hasOwnProperty("windows") << 1) + x.hasOwnProperty("regexp")) {
            case 0: x._visible = true; break;
            case 1: x._visible = RegExp(x.regexp).test(text); break;
            case 2: x._visible = x.windows.toLowerCase().includes(fw.toLowerCase()); break;
            case 3: x._visible = x.windows.toLowerCase().includes(fw.toLowerCase()) & RegExp(x.regexp).test(text); break;
            }
        });
        this._updatePages();
    }

    _iconMaker(cmd) {
        let x = JSON.parse(cmd);
        if(!x.enable) return;
        let btn = new St.Button({
            reactive: true,
            style_class: 'light-dict-button-%s light-dict-button'.format(x.icon || 'help'),
        });
        btn.child = new St.Icon({
            icon_name: x.icon || 'help',
            fallback_icon_name: 'help',
            style_class: 'light-dict-button-icon-%s light-dict-button-icon'.format(x.icon || 'help'),
        });
        if(x.windows) btn.windows = x.windows;
        if(x.regexp) btn.regexp = x.regexp;
        btn.connect('clicked', (actor, event) => {
            this._hide();
            this.emit('iconbar-signals', [x.popup, x.clip, x.type, x.commit].map(x => x ? '1' : '0').join(''), x.command);
            return Clutter.EVENT_STOP;
        });
        btn.connect('enter-event', () => {
            if(!this._tooltips) return;
            btn.entered = true;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._autohide / 2, () => {
                if(!btn.entered || !this._box.visible) return GLib.SOURCE_REMOVE;
                this._iconTooltips.set_position(global.get_pointer()[0], this.get_position()[1] + this.get_size()[1] + 5);
                this._iconTooltips.set_text(x.tooltip ? x.tooltip : x.icon || 'tooltips');
                this._iconTooltips.show();
                return GLib.SOURCE_REMOVE;
            });
        });
        btn.connect('leave-event', () => {
            if(!this._tooltips) return;
            btn.entered = false;
            this._iconTooltips.hide();
        });
        btn._visible = true;
        this._box.add_child(btn);
    }

    _show(fw, text) {
        this._updateVisible(fw, text);
        if(this._pages < 1) return;
        if(!this._box.visible) {
            this._box.visible = true;
            this.open(BoxPointer.PopupAnimation.FULL);
            this.get_parent().set_child_above_sibling(this, null);
        }

        if(this._delayID)
            GLib.source_remove(this._delayID), this._delayID = 0;

        this._delayID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._autohide, () => {
            this._hide();
            this._delayID = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _hide() {
        if(!this._box.visible) return;

        this._box.visible = false;
        if(this._tooltips) this._iconTooltips.hide();
    }

    destory() {
        if(this._delayID)
            GLib.source_remove(this._delayID), this._delayID = 0;
        if(this._leaveID)
            this._box.disconnect(this._leaveID), this._leaveID = 0;
        if(this._enterID)
            this._box.disconnect(this._enterID), this._enterID = 0;
        if(this._scrollID)
            this._box.disconnect(this._scrollID), this._scrollID = 0;
        for(let x in this)
            if(RegExp(/^_.+Id_$/).test(x)) eval('if(this.%s) gsettings.disconnect(this.%s), this.%s = 0;'.format(x, x, x));
        this._bcommands = [];
        this._tooltips = false;
        this._box.destroy();
        this._box = null;
        super.destroy();
    }
});

const DictBox = GObject.registerClass(
class DictBox extends BoxPointer.BoxPointer {
    _init() {
        super._init(St.Side.TOP);
        this.style_class = 'light-dict-box-boxpointer';
        this.style = '-arrow-border-radius: 10px;';
        Main.layoutManager.addTopChrome(this);

        this._selection = '';
        this._notFound = false;

        this._buildWidget();
        this._fetchSettings();
        this._loadSettings();
    }

    _buildWidget() {
        this._view = new St.ScrollView({
            visible: false,
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
            overlay_scrollbars: true,
            style_class: 'light-dict-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            style: 'max-height: %dpx'.format(global.display.get_size()[1] * 7 / 16),
        });

        this._box = new St.BoxLayout({
            reactive: true,
            vertical: true,
            style_class: 'light-dict-content',
        });

        this._word = new St.Label({ style_class: 'light-dict-word' });
        this._word.clutter_text.line_wrap = true;
        this._word.clutter_text.line_wrap_mode = Pango.WrapMode.WORD;
        this._word.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        this._info = new St.Label({ style_class: 'light-dict-info' });
        this._info.clutter_text.line_wrap = true;
        this._info.clutter_text.line_wrap_mode = Pango.WrapMode.WORD;
        this._info.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        this._box.add_child(this._word);
        this._box.add_child(this._info);
        this._view.add_actor(this._box);
        this.bin.set_child(this._view);
    }

    _fetchSettings() {
        this._hidetitle = gsettings.get_boolean(Fields.HIDETITLE);
    }

    _loadSettings() {
        this._leaveID = this._box.connect('leave-event', this._onLeave.bind(this));
        this._enterID = this._box.connect('enter-event', this._onEnter.bind(this));
        this._clickID = this._box.connect('button-press-event', this._onClick.bind(this));

        this._hidetitleId_ = gsettings.connect('changed::' + Fields.HIDETITLE, () => { this._hidetitle = gsettings.get_boolean(Fields.HIDETITLE); });
    }

    set _hidetitle(hide) {
        this._word.visible = !hide;
    }

    get _autohide() {
        return gsettings.get_uint(Fields.AUTOHIDE);
    }

    get _logslevel() {
        return gsettings.get_uint(Fields.LOGSLEVEL);
    }

    get _rcommand() {
        return gsettings.get_string(Fields.RCOMMAND);
    }

    get _lcommand() {
        return gsettings.get_string(Fields.LCOMMAND);
    }

    get _dcommand() {
        return gsettings.get_string(Fields.DCOMMAND);
    }

    get _scrollable() {
        let [, height] = this._view.get_preferred_height(-1);
        let maxHeight = this._view.get_theme_node().get_max_height();
        if(maxHeight < 0) maxHeight = global.display.get_size()[1] * 7 / 16;

        return height >= maxHeight;
    }

    _onEnter() {
        this._view.visible = true;
        if(this._logslevel === LOGSLEVEL.HOVER) this._recordLog();
        if(this._delayID) GLib.source_remove(this._delayID), this._delayID = 0;
    }

    _onClick(actor, event) {
        switch(event.get_button()) {
        case 1:
            if(this._logslevel === LOGSLEVEL.CLICK)
                this._recordLog();
            if(this._lcommand)
                this._spawn(this._lcommand.replace(/LDWORD/g, GLib.shell_quote(this._selection)));
            break;
        case 2:
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._info.get_text());
            break;
        case 3:
            if(this._rcommand)
                this._spawn(this._rcommand.replace(/LDWORD/g, GLib.shell_quote(this._selection)));
            this._hide();
            break;
        default:
            break;
        }
    }

    _onLeave() {
        //NOTE: do not hide on scrolling
        let [mx, my] = global.get_pointer();
        let [wt, ht] = this.get_size();
        let [px, py] = this.get_position();
        if(mx > px + 1 && my > py + 1 && mx < px + wt - 1 && my < py + ht -1) return;

        this._hide();
    }

    _spawn(rcmd) {
        try {
            let proc = new Gio.Subprocess({
                argv: ['/bin/bash', '-c', rcmd],
                flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
            });
            proc.init(null);
        } catch(e) {
            Main.notifyError(Me.metadata.name, e.message);
        }
    }

    _recordLog() {
        if(this._prevLog && this._selection == this._prevLog)
            return;
        let dateFormat = (fmt, date) => {
            const opt = {
                "Y+": date.getFullYear().toString(),
                "m+": (date.getMonth() + 1).toString(),
                "d+": date.getDate().toString(),
                "H+": date.getHours().toString(),
                "M+": date.getMinutes().toString(),
                "S+": date.getSeconds().toString()
            };
            let ret;
            for(let k in opt) {
                ret = new RegExp("(" + k + ")").exec(fmt);
                if(!ret) continue;
                fmt = fmt.replace(ret[1], (ret[1].length == 1) ? (opt[k]) : (opt[k].padStart(ret[1].length, "0")))
            };
            return fmt;
        }
        let logfile = Gio.file_new_for_path(GLib.get_home_dir() + '/.cache/gnome-shell-extension-light-dict/light-dict.log');
        let log = [dateFormat("YYYY-mm-dd HH:MM:SS", new Date()), this._selection, this._notFound ? 0 : 1].join('\t') + '\n';
        try {
            logfile.append_to(Gio.FileCreateFlags.NONE, null).write(log, null);
        } catch(e) {
            Main.notifyError(Me.metadata.name, e.message);
        }
        this._prevLog = this._selection;
    }

    _lookUp(text) {
        let rcmd = this._dcommand.replace(/LDWORD/g, GLib.shell_quote(text));
        let proc = new Gio.Subprocess({
            argv: ['/bin/bash', '-c', 'set -o pipefail;' + rcmd],
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        proc.init(null);
        proc.communicate_utf8_async(null, null, (proc, res) => {
            try {
                let [, stdout, stderr] = proc.communicate_utf8_finish(res);
                this._notFound = proc.get_exit_status() !== 0;
                this._show(this._notFound ? stderr.trim() : stdout.trim(), text);
                if(this._logslevel === LOGSLEVEL.ALWAYS) this._recordLog();
            } catch(e) {
                Main.notifyError(Me.metadata.name, e.message);
            }
        });
    }

    _hide() {
        if(!this._view.visible) return;

        this._view.visible = false;
        this.close(BoxPointer.PopupAnimation.FULL);
        this._info.set_text(Me.metadata.name);
    }

    _show(info, word) {
        this._selection = word;

        try {
            Pango.parse_markup(info, -1, '');
            this._info.clutter_text.set_markup(info);
        } catch(e) {
            this._info.set_text(info);
        }
        if(this._word.visible)
            this._word.set_text(word);

        if(this._scrollable) {
            this._view.vscrollbar_policy = St.PolicyType.AUTOMATIC;
            this._view.vscroll.get_adjustment().set_value(0);
        } else {
            this._view.vscrollbar_policy = St.PolicyType.NEVER;
        }

        if(!this._view.visible) {
            this._view.visible = true;
            this.open(BoxPointer.PopupAnimation.FULL);
            this.get_parent().set_child_above_sibling(this, null);
        }

        if(this._delayID)
            GLib.source_remove(this._delayID), this._delayID = 0;

        this._delayID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._autohide, () => {
            this._hide();
            this._delayID = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    destory() {
        if(this._delayID)
            GLib.source_remove(this._delayID), this._delayID = 0;
        if(this._leaveID)
            this._box.disconnect(this._leaveID), this._leaveID = 0;
        if(this._enterID)
            this._box.disconnect(this._enterID), this._enterID = 0;
        if(this._clickID)
            this._box.disconnect(this._clickID), this._clickID = 0;
        for(let x in this)
            if(RegExp(/^_.+Id_$/).test(x)) eval('if(this.%s) gsettings.disconnect(this.%s), this.%s = 0;'.format(x, x, x));

        this._word.destroy();
        this._info.destroy();
        this._box.destroy();
        this._view.destroy();
        this._word = null;
        this._info = null;
        this._box = null;
        this._view = null
        super.destroy();
    }
});

const DictAct = GObject.registerClass(
class DictAct extends GObject.Object {
    _init() {
        super._init();
        let seat = Clutter.get_default_backend().get_default_seat();
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._input = Keyboard.getInputSourceManager();
    }

    _release(keyname) {
        this._keyboard.notify_keyval(
            Clutter.get_current_event_time(),
            Gdk.keyval_from_name(keyname),
            Clutter.KeyState.RELEASED
        );
    }

    _press(keyname) {
        this._keyboard.notify_keyval(
            Clutter.get_current_event_time(),
            Gdk.keyval_from_name(keyname),
            Clutter.KeyState.PRESSED
        );
    }

    stroke(keystring) {
        try {
            keystring.split(/\s+/).forEach((keys, i) => {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, i * 100, () => {
                    let keyarray = keys.split('+');
                    keyarray.forEach(key => this._press(key));
                    keyarray.slice().reverse().forEach(key => this._release(key));
                    return GLib.SOURCE_REMOVE;
                });
            });
        } catch(e) {
            Main.notifyError(Me.metadata.name, e.message);
        }
        // TODO: Modifier keys aren't working on Wayland (input area)
    }

    commit(string) {
        if(this._input.currentSource.type == Keyboard.INPUT_SOURCE_TYPE_IBUS) {
            if(this._input._ibusManager._panelService)
                this._input._ibusManager._panelService.commit_text(IBus.Text.new_from_string(string));
        } else {
            Main.inputMethod.commit(string); // TODO: not tested
        }
    }

    copy(string) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, string);
    }

    search() {
        this.stroke('Control_L+c Super_L Control_L+v');
    }
});

const LightDict = GObject.registerClass(
class LightDict extends St.Widget {
    _init() {
        super._init({
            width: 40,
            height: 40,
            opacity: 0,
        });
        Main.uiGroup.add_actor(this); // do not track

        this._wmclass = '';
        this._selection = '';
        this._disable = false;

        this._buildWidget();
        this._fetchSettings();
        this._loadSettings();
    }

    _buildWidget() {
        this._box = new DictBox();
        this._act = new DictAct();
        this._bar = new DictBar();

        this._box.setPosition(this, 0);
        this._bar.setPosition(this, 0);

        this._dbus = Gio.DBusExportedObject.wrapJSObject(DBUSINTERFACE, this);
        this._dbus.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/LightDict');
        this._spawn = x => this._box._spawn(x);
    }

    _fetchSettings() {
        this._shortcut  = gsettings.get_boolean(Fields.SHORTCUT);
    }

    _loadSettings() {
        this._scrollID = this.connect('scroll-event', this._hide.bind(this));
        this._clickID = this.connect('button-press-event', this._hide.bind(this));
        this._barEmitID = this._bar.connect('iconbar-signals', this._onBarEmit.bind(this));

        this._onWindowChangedID = global.display.connect('notify::focus-window', this._onWindowChanged.bind(this));
        this._selectionChangedID = global.display.get_selection().connect('owner-changed', this._selectionChanged.bind(this));
        this._shortcutId_ = gsettings.connect('changed::' + Fields.SHORTCUT, () => { this._shortcut = gsettings.get_boolean(Fields.SHORTCUT); });
    }

    get _passive() {
        return gsettings.get_boolean(Fields.PASSIVE);
    }

    get _filter() {
        return gsettings.get_string(Fields.FILTER);
    }

    get _trigger() {
        return gsettings.get_uint(Fields.TRIGGER);
    }

    get _appslist() {
        return gsettings.get_string(Fields.APPSLIST);
    }

    get _blackwhite() {
        return gsettings.get_boolean(Fields.BLACKWHITE);
    }

    get _textstrip() {
        return gsettings.get_boolean(Fields.TEXTSTRIP);
    }

    set _pointer(pointer) {
        this.set_position(pointer[0] - 20, pointer[1] - 20);
    }

    set _shortcut(shortcut) {
        if(shortcut) {
            Main.wm.addKeybinding(Fields.TOGGLE, gsettings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.ALL, this._changeMode.bind(this));
        } else {
            Main.wm.removeKeybinding(Fields.TOGGLE);
        }
    }

    _changeMode() {
        let next = (this._trigger + 1) % 2;
        Main.notify(Me.metadata.name, _('Switch to %s mode').format(Object.keys(TRIGGER)[next]));
        gsettings.set_uint(Fields.TRIGGER, next);
    }

    _onWindowChanged() {
        this._hide();
        let FW = global.display.get_focus_window();
        this._wmclass = FW ? (FW.wm_class ? FW.wm_class : '') : '';
        let wlist = this._appslist === '*' || this._appslist.toLowerCase().includes(this._wmclass.toLowerCase());
        this._disable = this._blackwhite ? !wlist : wlist;
    }

    _onBarEmit(actor, tag, cmd) {
        let [popup, clip, type, commit] = Array.from(tag, i => i === '1');
        if(type) {
            this._runWithEval(popup, clip, commit, cmd);
        } else {
            this._runWithBash(popup, clip, commit, cmd);
        }
    }

    _selectionChanged(sel, type, src) {
        if(type != St.ClipboardType.PRIMARY) return;
        if(this._mouseUpID)
            GLib.source_remove(this._mouseUpID), this._mouseUpID = 0;
        if(this._disable || this._trigger == TRIGGER.NIL) return;
        let [, , initModifier] = global.get_pointer();
        if(this._passive && (initModifier & MODIFIERS) == 0) return;
        if(initModifier & Clutter.ModifierType.BUTTON1_MASK) {
            this._mouseUpID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                let [, , tmpModifier] = global.get_pointer();
                if((initModifier ^ tmpModifier) == Clutter.ModifierType.BUTTON1_MASK) {
                    this._fetchSelection();
                    this._mouseUpID = 0;
                    return GLib.SOURCE_REMOVE;
                } else {
                    return GLib.SOURCE_CONTINUE;
                }
            });
        } else {
            this._fetchSelection();
        }
    }

    _fetchSelection() {
        St.Clipboard.get_default().get_text(St.ClipboardType.PRIMARY, (clip, text) =>  {
            if(!text) return;
            this._pointer = global.get_pointer();
            this._selection = this._textstrip ? text.trim().replace(/\n/g, ' ') : text;
            this._show();
        });
    }

    _runWithBash(popup, clip, commit, cmd) {
        let title = global.display.get_focus_window().title.toString();
        let rcmd = cmd.replace(/LDWORD/g, GLib.shell_quote(this._selection)).replace(/LDTITLE/g, GLib.shell_quote(title));
        if(popup|clip|commit) {
            let proc = new Gio.Subprocess({
                argv: ['/bin/bash', '-c', 'set -o pipefail;' + rcmd],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc.init(null);
            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    let [, stdout, stderr] = proc.communicate_utf8_finish(res);
                    if(proc.get_exit_status() === 0) {
                        let result = stdout.trim();
                        if(clip) this._act.copy(result);
                        if(commit) this._act.commit(result);
                        if(popup) this._box._show(result, this._selection);
                    } else {
                        this._box._show(stderr.trim(), this._selection);
                    }
                } catch(e) {
                    Main.notifyError(Me.metadata.name, e.message);
                }
            });
        } else {
            this._spawn(rcmd);
        }
    }

    _runWithEval(popup, clip, commit, cmd) {
        try {
            let LDWORD = this._selection;
            let LDTITLE = global.display.get_focus_window().title;
            let key = x => this._act.stroke(x);
            let copy = x => this._act.copy(x);
            let commit = x => this._act.commit(x);
            if(popup|clip|commit) {
                let result = eval(cmd).toString();
                if(clip) this._act.copy(result);
                if(commit) this._act.commit(result);
                if(popup) this._box._show(result, this._selection);
            } else {
                eval(cmd);
            }
        } catch(e) {
            Main.notifyError(Me.metadata.name, e.message);
        }
    }

    _show() {
        if(this._trigger == TRIGGER.BAR) {
            this._box._hide();
            this._bar._show(this._wmclass, this._selection);
        } else {
            if(!this._passive && this._filter && !RegExp(this._filter).test(this._selection)) return;
            this._bar._hide();
            this._box._lookUp(this._selection);
        }
    }

    _hide() {
        this._box._hide();
        this._bar._hide();
        this._pointer = global.display.get_size();
    }

    LookUp(word) {
        if(word) {
            this._selection = word;
            this._pointer = global.get_pointer();
            this._box._lookUp(this._selection);
        } else {
            St.Clipboard.get_default().get_text(St.ClipboardType.PRIMARY, (clip, text) =>  {
                if(!text) return;
                this._pointer = global.get_pointer();
                this._selection = this._textstrip ? text.trim().replace(/\n/g, ' ') : text;
                this._box._lookUp(this._selection);
            });
        }
    }

    ShowBar(word) {
        if(word) {
            this._selection = word;
            this._pointer = global.get_pointer();
            this._bar._show(this._wmclass, this._selection);
        } else {
            St.Clipboard.get_default().get_text(St.ClipboardType.PRIMARY, (clip, text) =>  {
                if(!text) return;
                this._pointer = global.get_pointer();
                this._selection = this._textstrip ? text.trim().replace(/\n/g, ' ') : text;
                this._bar._show(this._wmclass, this._selection);
            });
        }
    }

    destory() {
        if(this._mouseUpID)
            GLib.source_remove(this._mouseUpID), this._mouseUpID = 0;
        if(this._barEmitID)
            this._bar.disconnect(this._barEmitID), this._barEmitID = 0;
        if(this._onWindowChangedID)
            global.display.disconnect(this._onWindowChangedID), this._onWindowChangedID = 0;
        if(this._selectionChangedID)
            global.display.get_selection().disconnect(this._selectionChangedID), this._selectionChangedID = 0;
        for(let x in this)
            if(RegExp(/^_.+Id_$/).test(x)) eval('if(this.%s) gsettings.disconnect(this.%s), this.%s = 0;'.format(x, x, x));

        Main.uiGroup.remove_actor(this);
        this._shortcut = false;
        this._dbus.flush();
        this._dbus.unexport();
        this._bar.destory();
        this._box.destroy();
        this._dbus = null;
        this._bar = null;
        this._box = null;
        this._act = null;
        super.destroy();
    }
});

const Extension = GObject.registerClass(
class Extension extends GObject.Object {
    _init() {
        super._init();
        let logfilePath = Gio.file_new_for_path(GLib.get_home_dir() + '/.cache/gnome-shell-extension-light-dict/');
        if(!logfilePath.query_exists(null)) logfilePath.make_directory(Gio.Cancellable.new());
    }

    _setDefault() {
        if(this._default) {
            this._dict._box.add_style_class_name('default');
            this._dict._bar.add_style_class_name('default');
        } else {
            this._dict._box.remove_style_class_name('default');
            this._dict._bar.remove_style_class_name('default');
        }
    }

    get _default() {
        return gsettings.get_boolean(Fields.DEFAULT);
    }

    get _systray() {
        return gsettings.get_boolean(Fields.SYSTRAY);
    }

    get _passive() {
        return gsettings.get_boolean(Fields.PASSIVE);
    }

    get _trigger() {
        return gsettings.get_uint(Fields.TRIGGER);
    }

    get _iconname() {
        switch(this._trigger) {
        case TRIGGER.NIL: return this._passive ? 'nil-passive' : 'nil-active';
        case TRIGGER.BOX: return this._passive ? 'box-passive' : 'box-active';
        case TRIGGER.BAR: return this._passive ? 'bar-passive' : 'bar-active';
        }
    }

    _setIcon() {
        this._icon.set_gicon(new Gio.FileIcon({ file: Gio.File.new_for_path(getIcon(this._iconname)) }));
        this._updateMenu();
    }

    _setSystray() {
        if(this._systray) {
            if(Main.panel.statusArea[Me.metadata.uuid]) return;
            this._addButton();
        } else {
            if(!Main.panel.statuaArea[Me.metadata.uuid]) return;
            this._button.destroy();
            this._button = null;
        }
    }

    _addButton() {
        this._button = new PanelMenu.Button(null);
        this._icon = new St.Icon({
            gicon: new Gio.FileIcon({ file: Gio.File.new_for_path(getIcon(this._iconname)) }),
            style_class: 'light-dict-systray system-status-icon',
        });
        this._button.add_actor(this._icon);
        this._passiveId_ = gsettings.connect('changed::' + Fields.PASSIVE, this._setIcon.bind(this));
        this._triggerId_ = gsettings.connect('changed::' + Fields.TRIGGER, this._setIcon.bind(this));

        this._updateMenu();
        Main.panel.addToStatusArea(Me.metadata.uuid, this._button);
    }

    _updateMenu() {
        this._button.menu.removeAll();
        ['Bar', 'Box', 'Nil'].forEach(x => this._button.menu.addMenuItem(this._menuItemMaker(x)));
        this._button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(''));
        this._button.menu.addMenuItem(this._passiveItem());
        this._button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(''));
        this._button.menu.addMenuItem(this._settingItem());
    }

    _menuItemMaker(text) {
        let item = new PopupMenu.PopupBaseMenuItem({ style_class: 'light-dict-item' });
        item.setOrnament(this._trigger == TRIGGER[text.toUpperCase()] ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        item.connect('activate', () => { item._getTopMenu().close(); gsettings.set_uint(Fields.TRIGGER, TRIGGER[text.toUpperCase()]); });
        item.add_child(new St.Label({ x_expand: true, text: _(text), }));

        return item;
    }

    _passiveItem() {
        let item = new PopupMenu.PopupBaseMenuItem({ style_class: 'light-dict-item' });
        item.setOrnament(this._passive ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        item.connect('activate', () => { item._getTopMenu().close(); gsettings.set_boolean(Fields.PASSIVE, !this._passive); });
        item.add_child(new St.Label({ x_expand: true, text: _('Passive mode'), }));

        return item;
    }

    _settingItem() {
        let item = new PopupMenu.PopupBaseMenuItem({ style_class: 'light-dict-item' });
        item.connect('activate', () => { item._getTopMenu().close(); ExtensionUtils.openPrefs(); });
        item.add_child(new St.Label({ x_expand: true, text: _('Settings'), }));

       return item;
    }

    enable() {
        this._dict = new LightDict();
        if(this._default) this._setDefault();
        if(this._systray) this._addButton();

        this._defaultId_ = gsettings.connect('changed::' + Fields.DEFAULT, this._setDefault.bind(this));
        this._systrayId_ = gsettings.connect('changed::' + Fields.SYSTRAY, this._setSystray.bind(this));
    }

    disable() {
        for(let x in this)
            if(RegExp(/^_.+Id_$/).test(x)) eval('if(this.%s) gsettings.disconnect(this.%s), this.%s = 0;'.format(x, x, x));

        if(this._systray) {
            this._button.destroy();
            this._button = null;
        }
        this._dict.destory();
        this._dict = null;
    }
});

function init() {
    ExtensionUtils.initTranslations();
    return new Extension();
}

