// vim:fdm=syntax
// by: tuberry@gtihub
'use strict';

const Main = imports.ui.main;
const Util = imports.misc.util;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const BoxPointer = imports.ui.boxpointer;
const Keyboard = imports.ui.status.keyboard;
const { Meta, Shell, Clutter, IBus, Gio, GLib, GObject, St, Pango, Gdk } = imports.gi;

const InputSources = Keyboard.getInputSourceManager();
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const gsettings = ExtensionUtils.getSettings();
const Fields = Me.imports.prefs.Fields;
const _ = imports.gettext.domain(Me.metadata['gettext-domain']).gettext;
const getIcon = x => Me.dir.get_child('icons').get_child(x + '-symbolic.svg').get_path();

const TriggerType = { Swift: 0, Popup: 1, Disable: 2 };
const MODIFIERS = Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SHIFT_MASK;
const DBUSINTERFACE = `
<node>
    <interface name="org.gnome.Shell.Extensions.LightDict">
        <method name="Swift">
            <arg type="s" direction="in" name="word"/>
        </method>
        <method name="Popup">
            <arg type="s" direction="in" name="word"/>
        </method>
        <method name="Toggle">
        </method>
        <method name="Block">
        </method>
    </interface>
</node>`;

const DictBar = GObject.registerClass({
    Properties: {
        'tooltips': GObject.param_spec_boolean('tooltips', 'tooltips', 'tooltips', false, GObject.ParamFlags.WRITABLE),
        'pagesize': GObject.param_spec_uint('pagesize', 'pagesize', 'page zise', 1, 10, 5, GObject.ParamFlags.READWRITE),
        'xoffset':  GObject.param_spec_int('xoffset', 'xoffset', 'x offset', -400, 400, -5, GObject.ParamFlags.WRITABLE),
        'autohide': GObject.param_spec_uint('autohide', 'autohide', 'auto hide', 500, 10000, 2500, GObject.ParamFlags.READWRITE),
       // 'pcommands': GObject.param_spec_variant('pcommands', '', '', new GLib.VariantType('as'), null, GObject.ParamFlags.WRITABLE),
    },
    Signals: {
        'dict-bar-clicked': { param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING] },
    },
}, class DictBar extends BoxPointer.BoxPointer {
    _init(actor, align) {
        super._init(St.Side.BOTTOM);
        this.style_class = 'light-dict-bar-boxpointer';
        Main.layoutManager.addTopChrome(this);
        this.setPosition(actor, align);

        this._pages = 1;
        this._index = 1;

        this._buildWidgets();
        this._bindSettings();
    }

    _buildWidgets() {
        this._box = new St.BoxLayout({
            visible: false,
            reactive: true,
            vertical: false,
            style_class: 'light-dict-iconbox',
        });
        this.bin.set_child(this._box);

        this._box.connect('leave-event', this._onLeave.bind(this));
        this._box.connect('enter-event', this._onEnter.bind(this));
        this._box.connect('scroll-event', this._onScroll.bind(this));
    }

    _bindSettings() {
        // gsettings.bind(Fields.PCOMMANDS, this, 'pcommands', Gio.SettingsBindFlags.GET, ); // NOTE: unavailable
        gsettings.bind(Fields.XOFFSET,  this, 'xoffset',  Gio.SettingsBindFlags.GET);
        gsettings.bind(Fields.TOOLTIP,  this, 'tooltips', Gio.SettingsBindFlags.GET);
        gsettings.bind(Fields.PAGESIZE, this, 'pagesize', Gio.SettingsBindFlags.GET);
        gsettings.bind(Fields.AUTOHIDE, this, 'autohide', Gio.SettingsBindFlags.GET);
        this.pcommands = gsettings.get_strv(Fields.PCOMMANDS);
        this.pcommandsId = gsettings.connect('changed::' + Fields.PCOMMANDS, () => { this.pcommands = gsettings.get_strv(Fields.PCOMMANDS); });
    }

    set tooltips(tooltips) {
        if(tooltips) {
            if(this._tooltip) return;
            this._tooltip = new St.Label({
                visible: false,
                style_class: 'light-dict-tooltips',
            });
            Main.layoutManager.addTopChrome(this._tooltip);
        } else {
            if(!this._tooltip) return;
            this._tooltip.destroy();
            delete this._tooltip;
        }
    }

    set xoffset(offset) {
        this.set_style('-arrow-border-radius: %dpx;'.format(-offset + 20));
    }

    set pcommands(commands) {
        this._index = 1;
        this._box.remove_all_children();
        commands.forEach(x => this._iconMaker(x));
    }

    get _icons() {
        return this._box.get_children();
    }

    _onScroll(actor, event) {
        if(this._tooltip) this._tooltip.hide();
        this._icons.forEach(x => x.entered = false);
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP: this._index--; break;
        case Clutter.ScrollDirection.DOWN: this._index++; break;
        }
        this._updatePages();
    }

    _onEnter() {
        if(this._delayId)
            GLib.source_remove(this._delayId), this._delayId = 0;
        this._box.visible = true;
    }

    _onLeave(actor) {
        if(this._delayId)
            GLib.source_remove(this._delayId), this._delayId = 0;
        this._delayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, actor ? this.autohide / 2 : this.autohide, () => {
            this._hide();
            this._delayId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _updatePages() {
        this._icons.forEach(x => x.visible = x._visible);
        if(this.pagesize === 0) return;
        let icons = this._icons.filter(x => x._visible);
        this._pages = Math.ceil(icons.length / this.pagesize);
        if(this._pages === 1 || this._pages === 0) return;
        this._index = this._index < 1 ? this._pages : (this._index > this._pages ? 1 : this._index);
        if(this._index === this._pages && icons.length % this.pagesize) {
            icons.forEach((x, i) => { x.visible = i >= icons.length - this.pagesize && i < icons.length; });
        } else {
            icons.forEach((x, i) => { x.visible = i >= (this._index - 1)*this.pagesize && i < this._index*this.pagesize; });
        }
    }

    _updateVisible(wmclass, text) {
        this._icons.forEach(x => {
            switch((!!x.windows << 1) + !!x.regexp) {
            case 0: x._visible = true; break;
            case 1: x._visible = RegExp(x.regexp).test(text); break;
            case 2: x._visible = x.windows.toLowerCase().includes(wmclass.toLowerCase()); break;
            case 3: x._visible = x.windows.toLowerCase().includes(wmclass.toLowerCase()) & RegExp(x.regexp).test(text); break;
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
        Object.assign(btn, x);
        btn.connect('clicked', (actor, event) => {
            this._hide();
            this.emit('dict-bar-clicked',x.command, [x.type, x.popup, x.copy, x.commit, x.select].map(x => x ? '1' : '0').join(''));
            return Clutter.EVENT_STOP;
        });
        btn.connect('enter-event', () => {
            if(!this._tooltip) return;
            btn.entered = true;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.autohide / 2, () => {
                if(!btn.entered || !this._box.visible) return GLib.SOURCE_REMOVE;
                this._tooltip.set_position(global.get_pointer()[0], this.get_position()[1] + this.get_size()[1] + 5);
                this._tooltip.set_text(x.tooltip || (x.icon || 'tooltip'));
                this._tooltip.show();
                return GLib.SOURCE_REMOVE;
            });
        });
        btn.connect('leave-event', () => {
            if(!this._tooltip) return;
            btn.entered = false;
            this._tooltip.hide();
        });
        btn._visible = true;
        this._box.add_child(btn);
    }

    _show(fw, text) {
        this._hide();
        this._updateVisible(fw, text);
        if(this._pages < 1) return;
        if(!this._box.visible) {
            this._box.visible = true;
            this.open(BoxPointer.PopupAnimation.FULL);
            this.get_parent().set_child_above_sibling(this, null);
        }

        this._onLeave();
    }

    _hide() {
        if(!this._box.visible) return;

        this._box.visible = false;
        if(this._tooltip) this._tooltip.hide();
    }

    destroy() {
        if(this._delayId)
            GLib.source_remove(this._delayId), this._delayId = 0;
        if(this.pcommandsId)
            gsettings.disconnect(this.pcommandsId), this.pcommandsId = 0;

        this.tooltips = false;
        super.destroy();
    }
});

const DictBox = GObject.registerClass({
    Properties: {
        'lcommand': GObject.param_spec_string('lcommand', 'lcommand', 'l command', '', GObject.ParamFlags.READWRITE),
        'rcommand': GObject.param_spec_string('rcommand', 'rcommand', 'r command', '', GObject.ParamFlags.READWRITE),
        'autohide': GObject.param_spec_uint('autohide', 'autohide', 'auto hide', 500, 10000, 2500, GObject.ParamFlags.READWRITE),
    },
}, class DictBox extends BoxPointer.BoxPointer {
    _init(actor, align) {
        super._init(St.Side.TOP);
        this.style_class = 'light-dict-box-boxpointer';
        this.style = '-arrow-border-radius: 10px;';
        Main.layoutManager.addTopChrome(this);
        this.setPosition(actor, align); // NOTE: disable => enable :: ...internal: assertion '!isnan (box->x1)...

        this._selection = '';
        this._notFound = false;

        this._bindSettings();
        this._buildWidgets();
    }

    _buildWidgets() {
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

        this._box.connect('leave-event', this._onLeave.bind(this));
        this._box.connect('enter-event', this._onEnter.bind(this));
        this._box.connect('button-press-event', this._onClick.bind(this));
        gsettings.bind(Fields.HIDETITLE, this._word, 'visible', Gio.SettingsBindFlags.INVERT_BOOLEAN);
    }

    _bindSettings() {
        gsettings.bind(Fields.AUTOHIDE, this, 'autohide', Gio.SettingsBindFlags.GET);
        gsettings.bind(Fields.LCOMMAND, this, 'lcommand', Gio.SettingsBindFlags.GET);
        gsettings.bind(Fields.RCOMMAND, this, 'rcommand', Gio.SettingsBindFlags.GET);
    }

    get _scrollable() {
        let [, height] = this._view.get_preferred_height(-1);
        let maxHeight = this._view.get_theme_node().get_max_height();
        if(maxHeight < 0) maxHeight = global.display.get_size()[1] * 7 / 16;

        return height >= maxHeight;
    }

    _onEnter() {
        this._view.visible = true;
        if(this._delayId) GLib.source_remove(this._delayId), this._delayId = 0;
    }

    _onClick(actor, event) {
        switch(event.get_button()) {
        case 1:
            if(this.lcommand) Util.spawnCommandLine(this.lcommand.replace(/LDWORD/g, GLib.shell_quote(this._selection)));
            break;
        case 2:
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._info.get_text());
            break;
        case 3:
            if(this.rcommand) Util.spawnCommandLine(this.rcommand.replace(/LDWORD/g, GLib.shell_quote(this._selection)));
            this._hide();
            break;
        default:
            break;
        }
    }

    _onLeave() {
        // do not hide on scrolling
        let [mx, my] = global.get_pointer();
        let [wt, ht] = this.get_transformed_size();
        let [px, py] = this.get_transformed_position();
        if(mx > px + 1 && my > py + 1 && mx < px + wt - 1 && my < py + ht -1) return;

        this._hide();
    }

    _hide() {
        if(!this._view.visible) return;

        this._view.visible = false;
        this._info.set_text(Me.metadata.name);
        this.close(BoxPointer.PopupAnimation.FULL);
    }

    _show(info, word) {
        this._selection = word;

        try { // NOTE: seems St.Label doesn't show text more than the screen size even in St.ScrollView
            Pango.parse_markup(info, -1, '');
            this._info.clutter_text.set_markup(info);
        } catch(e) {
            this._info.set_text(info || '눈_눈');
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

        if(this._delayId)
            GLib.source_remove(this._delayId), this._delayId = 0;
        this._delayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.autohide, () => {
            this._hide();
            this._delayId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if(this._delayId)
            GLib.source_remove(this._delayId), this._delayId = 0;

        super.destroy();
    }
});

const DictAct = GObject.registerClass(
class DictAct extends GObject.Object {
    _init() {
        super._init();
        let seat = Clutter.get_default_backend().get_default_seat();
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
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
        keystring.split(/\s+/).forEach((keys, i) => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, i * 100, () => {
                let keyarray = keys.split('+');
                keyarray.forEach(key => this._press(key));
                keyarray.slice().reverse().forEach(key => this._release(key));
                return GLib.SOURCE_REMOVE;
            });
        }); // NOTE: Modifier keys aren't working on Wayland (input area)
    }

    commit(string) {
        if(InputSources.currentSource.type == Keyboard.INPUT_SOURCE_TYPE_IBUS) {
            if(InputSources._ibusManager._panelService)
                InputSources._ibusManager._panelService.commit_text(IBus.Text.new_from_string(string));
        } else {
            Main.inputMethod.commit(string); // TODO: not tested
        }
    }

    copy(string) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, string);
    }

    select(string) {
        St.Clipboard.get_default().set_text(St.ClipboardType.PRIMARY, string);
    }

    destroy() {
       delete this._keyboard;
    }
});

const DictBtn = GObject.registerClass({
    Properties: {
        'passive': GObject.param_spec_uint('passive', 'passive', 'passive', 0, 1, 0, GObject.ParamFlags.READWRITE),
        'trigger': GObject.param_spec_uint('trigger', 'trigger', 'trigger', 0, 2, 1, GObject.ParamFlags.READWRITE),
    },
    Signals: {
        'add-or-remove-wmclass': {},
    },
}, class DictBtn extends PanelMenu.Button {
    _init(params) {
        super._init(params);

        this._buildWidgets();
        this._bindSettings();
    }

    _buildWidgets() {
        this._icon = new St.Icon({ style_class: 'light-dict-systray system-status-icon', });
        this.add_actor(this._icon);
    }

    _bindSettings() {
        gsettings.bind(Fields.PASSIVE, this, 'passive', Gio.SettingsBindFlags.GET);
        gsettings.bind(Fields.TRIGGER, this, 'trigger', Gio.SettingsBindFlags.GET);
    }

    set passive(passive) {
        this._passive = passive;
        this._setIcon();
    }

    set trigger(trigger) {
        this._trigger = trigger;
        this._setIcon();
    }

    get _iconname() {
        switch(this._trigger) {
        case TriggerType.Disable: return this._passive == 1 ? 'disable-passive' : 'disable-proactive';
        case TriggerType.Popup:   return this._passive == 1 ? 'popup-passive' : 'popup-proactive';
        case TriggerType.Swift:   return this._passive == 1 ? 'swift-passive' : 'swift-proactive';
        }
    }

    vfunc_scroll_event(event) {
        switch(event.direction) {
        case Clutter.ScrollDirection.UP: gsettings.set_uint(Fields.TRIGGER, (this._trigger + 1) % 2); break;
        case Clutter.ScrollDirection.DOWN: gsettings.set_uint(Fields.PASSIVE, 1 - this._passive); break;
        default: break;
        }
        return Clutter.EVENT_STOP;
    };

    _setIcon() {
        this._icon.set_gicon(new Gio.FileIcon({ file: Gio.File.new_for_path(getIcon(this._iconname)) }));
        this._updateMenu();
    }

    get scommands() {
        return gsettings.get_strv(Fields.SCOMMANDS);
    }

    _scommandsMenu() {
        let scommand;
        let commands = this.scommands;
        let index = commands.findIndex(c => !!JSON.parse(c).enable);
        if(index < 0 || index >= commands.length) {
            scommand = new PopupMenu.PopupSubMenuMenuItem(_('Enabled: '));
            commands.forEach((x, i) => {
                let item = new PopupMenu.PopupMenuItem(JSON.parse(x).name);
                item.connect('activate', () => {
                    item._getTopMenu().close();
                    let inst = JSON.parse(comands[i]);
                    inst.enable = true;
                    commands[i] = JSON.stringify(inst, null, 0);
                    gsettings.set_int(Fields.SCOMMAND, i);
                    gsettings.set_strv(Fields.SCOMMANDS, commands);
                });
                scommand.menu.addMenuItem(item);
            });
        } else {
            scommand = new PopupMenu.PopupSubMenuMenuItem(_('Enabled: ') + JSON.parse(commands[index]).name);
            commands.forEach((x, i) => {
                let item = new PopupMenu.PopupMenuItem(JSON.parse(x).name);
                if(i == index) {
                    item.setOrnament(PopupMenu.Ornament.DOT);
                } else {
                    item.connect('activate', () => {
                        item._getTopMenu().close();
                        let cmds = commands.map(c => {
                            let conf = JSON.parse(c);
                            delete conf.enable;
                            return JSON.stringify(conf, null, 0);
                        });
                        let inst = JSON.parse(cmds[i]);
                        inst.enable = true;
                        cmds[i] = JSON.stringify(inst, null, 0);
                        gsettings.set_int(Fields.SCOMMAND, i);
                        gsettings.set_strv(Fields.SCOMMANDS, cmds);
                    });
                }
                scommand.menu.addMenuItem(item);
            });
        }

        return scommand
    }

    _updateMenu() {
        this.menu.removeAll();
        this.menu.addMenuItem(this._passiveItem());
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Trigger style')));
        Object.keys(TriggerType).forEach(x => this.menu.addMenuItem(this._menuItemMaker(x)));
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Swift commands')));
        this.menu.addMenuItem(this._scommandsMenu());
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Current window')));
        this.menu.addMenuItem(this._wmlistItem());
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('More')));
        this.menu.addMenuItem(this._settingItem());
    }

    _menuItemMaker(text) {
        let item = new PopupMenu.PopupBaseMenuItem({ style_class: 'light-dict-item' });
        item.setOrnament(this._trigger == TriggerType[text] ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        item.connect('activate', () => { item._getTopMenu().close(); gsettings.set_uint(Fields.TRIGGER, TriggerType[text]); });
        item.add_child(new St.Label({ x_expand: true, text: _(text), }));

        return item;
    }

    _passiveItem() {
        let item = new PopupMenu.PopupBaseMenuItem({ style_class: 'light-dict-item' });
        item.setOrnament(this._passive == 1 ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        item.connect('activate', () => { item._getTopMenu().close(); gsettings.set_uint(Fields.PASSIVE, 1 - this._passive); });
        item.add_child(new St.Label({ x_expand: true, text: _('Passive mode'), }));

        return item;
    }

    _wmlistItem() {
        let item = new PopupMenu.PopupBaseMenuItem({ style_class: 'light-dict-item' });
        item.connect('activate', () => { item._getTopMenu().close(); this.emit('add-or-remove-wmclass'); });
        item.add_child(new St.Label({ x_expand: true, text: _('Add/remove'), }));

        return item;
    }

    _settingItem() {
        let item = new PopupMenu.PopupBaseMenuItem({ style_class: 'light-dict-item' });
        item.connect('activate', () => { item._getTopMenu().close(); ExtensionUtils.openPrefs(); });
        item.add_child(new St.Label({ x_expand: true, text: _('Settings'), }));

       return item;
    }
});

const LightDict = GObject.registerClass({
    Properties: {
        'filter':    GObject.param_spec_string('filter', 'filter', 'filter', '', GObject.ParamFlags.READWRITE),
        'wmlist':    GObject.param_spec_string('wmlist', 'wmlist', 'wmclass list', '', GObject.ParamFlags.READWRITE),
        'systray':   GObject.param_spec_boolean('systray', 'systray', 'systray', true, GObject.ParamFlags.WRITABLE),
        'passive':   GObject.param_spec_uint('passive', 'passive', 'passive', 0, 1, 0, GObject.ParamFlags.READWRITE),
        'trigger':   GObject.param_spec_uint('trigger', 'trigger', 'trigger', 0, 2, 1, GObject.ParamFlags.READWRITE),
        'listtype':  GObject.param_spec_uint('listtype', 'listtype', 'list type', 0, 1, 1, GObject.ParamFlags.READWRITE),
        'textstrip': GObject.param_spec_boolean('textstrip', 'textstrip', 'strip text', true, GObject.ParamFlags.READWRITE),
        'scommand':  GObject.param_spec_int('scommand', 'scommand', 'swift command', -1, 2000, 0, GObject.ParamFlags.READWRITE),
    },
}, class LightDict extends St.Widget {
    _init() {
        super._init({
            width: 40,
            height: 40,
            opacity: 0,
        });
        Main.uiGroup.add_actor(this);

        this._block = false;
        this._selection = '';
        this._wmclass = global.display.focus_window?.wm_class ?? '';

        this._bindSettings();
        this._buildWidgets();
    }

    _bindSettings() {
        gsettings.bind(Fields.WMLIST,    this, 'wmlist',    Gio.SettingsBindFlags.DEFAULT);
        gsettings.bind(Fields.TRIGGER,   this, 'trigger',   Gio.SettingsBindFlags.DEFAULT);
        gsettings.bind(Fields.SYSTRAY,   this, 'systray',   Gio.SettingsBindFlags.GET);
        gsettings.bind(Fields.TXTFILTER, this, 'filter',    Gio.SettingsBindFlags.GET);
        gsettings.bind(Fields.LISTTYPE,  this, 'listtype',  Gio.SettingsBindFlags.GET);
        gsettings.bind(Fields.PASSIVE,   this, 'passive',   Gio.SettingsBindFlags.GET);
        gsettings.bind(Fields.TEXTSTRIP, this, 'textstrip', Gio.SettingsBindFlags.GET);
        gsettings.bind(Fields.SCOMMAND,  this, 'scommand',  Gio.SettingsBindFlags.GET);
        this.scommands = gsettings.get_strv(Fields.SCOMMANDS);
        this.scommandsId = gsettings.connect('changed::' + Fields.SCOMMANDS, () => { this.scommands = gsettings.get_strv(Fields.SCOMMANDS); });
    }

    _buildWidgets() {
        this._act = new DictAct();
        this._box = new DictBox(this, 0);
        this._bar = new DictBar(this, 0);

        this._dbus = Gio.DBusExportedObject.wrapJSObject(DBUSINTERFACE, this);
        this._dbus.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/LightDict');

        this._bar.connect('dict-bar-clicked', this._onBarClicked.bind(this));
        this._onWindowChangedId = global.display.connect('notify::focus-window', this._onWindowChanged.bind(this));
        this._onSelectChangedId = global.display.get_selection().connect('owner-changed', this._onSelectChanged.bind(this));
    }

    set systray(systray) {
        if(systray) {
            if(this._button) return;
            this._button = new DictBtn(null);
            this._button.connect('add-or-remove-wmclass', this.Block.bind(this));
            Main.panel.addToStatusArea(Me.metadata.uuid, this._button);
        } else {
            if(!this._button) return;
            this._button.destroy();
            delete this._button;
        }
    }

    set _pointer(pointer) {
        this.set_position(pointer[0] - 20, pointer[1] - 20);
    }

    set scommands(cmds) {
        if(!cmds.length) {
            this._scmd = null;
        } else {
            this._scmd = {};
            let index = (this.scommand < 0 || this.scommand >= cmds.length) ? 0 : this.scommand;
            Object.assign(this._scmd, JSON.parse(cmds[index]));
        }
        if(this._button) this._button._updateMenu();
    }

    get _allow() {
        let wlist = !this.wmlist || this.wmlist.toLowerCase().includes(this._wmclass.toLowerCase());
        return (this.listtype == 0)^wlist;
    }

    _onWindowChanged() {
        this._box._hide();
        this._bar._hide();
        this._wmclass = global.display.focus_window?.wm_class ?? '';
    }

    _onSelectChanged(sel, type, src) {
        if(type != St.ClipboardType.PRIMARY) return;
        if(this._mouseReleasedId)
            GLib.source_remove(this._mouseReleasedId), this._mouseReleasedId = 0;
        if(this._block) {
            this._block = false;
            return;
        }
        if(!this._allow || this.trigger == TriggerType.Disable) return;
        let [, , initModifier] = global.get_pointer();
        if(this.passive == 1 && (initModifier & MODIFIERS) == 0) return;
        if(initModifier & Clutter.ModifierType.BUTTON1_MASK) {
            this._mouseReleasedId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                let [, , tmpModifier] = global.get_pointer();
                if((initModifier ^ tmpModifier) == Clutter.ModifierType.BUTTON1_MASK) {
                    this._fetch().then(this._store.bind(this)).then(this._cope.bind(this));
                    this._mouseReleasedId = 0;
                    return GLib.SOURCE_REMOVE;
                } else {
                    return GLib.SOURCE_CONTINUE;
                }
            }); // NOTE: `owner-changed` is emitted every char in Gtk+ apps
        } else {
            this._fetch().then(this._store.bind(this)).then(this._cope.bind(this));
        }
    }

    _onBarClicked(actor, cmd, tag) {
        let [type, popup, copy, commit, select] = Array.from(tag, i => i === '1');
        if(type) {
            this._runWithJS(cmd, popup, copy, commit, select);
        } else {
            this._runWithSh(cmd, popup, copy, commit, select);
        }
    }

    _fetch() {
        return new Promise((resolve, reject) => {
            try {
                St.Clipboard.get_default().get_text(St.ClipboardType.PRIMARY, (clip, text) =>  { text ? resolve(text) : reject(); });
            } catch(e) {
                reject(e.message)
            }
        });
    }

    _store(text) {
        return new Promise((resolve, reject) => {
            let selection = this.textstrip ? text.replace(/[\n\t]/g, ' ').trim() : text;
            if(!selection) reject();
            this._selection = selection;
            this._pointer = global.get_pointer();
            resolve();
        });
    }

    _execute(cmd) {
        return new Promise((resolve, reject) => {
            try {
                let [, command] = GLib.shell_parse_argv(cmd);
                let proc = new Gio.Subprocess({
                    argv: command,
                    flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
                });
                proc.init(null);
                proc.communicate_utf8_async(null, null, (proc, res) => {
                    let [, stdout, stderr] = proc.communicate_utf8_finish(res);
                    proc.get_exit_status() ? reject(stderr.trim()) : resolve(stdout.trim());
                });
            } catch(e) {
                reject(e.message);
            }
        });
    }

    _runWithSh(cmd, pop, cpy, cmt, sel) {
        let rcmd = cmd.replace(/LDWORD/g, GLib.shell_quote(this._selection)).replace(/WMCLASS/g, GLib.shell_quote(this._wmclass));
        if(pop|cpy|cmt|sel) {
            this._execute(rcmd).then(scc => {
                if(sel) this._select(scc);
                if(cpy) this._act.copy(scc);
                if(cmt) this._act.commit(scc);
                if(pop) this._box._show(scc, this._selection);
            }).catch(err => {
                this._box._show(err, this._selection);
            });
        } else {
            Util.spawnCommandLine(rcmd);
        }
    }

    _runWithJS(cmd, pop, cpy, cmt, sel) {
        try {
            let WMCLASS = this._wmclass;
            let LDWORD = this._selection;
            let key = x => this._act.stroke(x);
            let copy = x => this._act.copy(x);
            let select = x => this._select(x);
            let commit = x => this._act.commit(x);
            if(pop|cpy|cmt|sel) {
                let result = eval(cmd).toString();
                if(cpy) copy(result);
                if(cmt) commit(result);
                if(sel) select(result);
                if(pop) this._box._show(result, this._selection);
            } else {
                eval(cmd);
            }
        } catch(e) {
            this._box._show(e.message, this._selection);
        }
    }

    _select(x) {
        this._block = true;
        this._act.select(x);
    }

    _cope() {
        if(this.passive == 0 && this.filter && !RegExp(this.filter).test(this._selection)) return;
        this.trigger == TriggerType.Popup ? this._popup() : this._swift();
    }

    _swift() {
        this._box._hide();
        if(!this._scmd) return;
        if(this._scmd.regexp && !RegExp(this._scmd.regexp).test(this._selection)) return;
        if(this._scmd.window && !this._scmd.windows.toLowerCase().includes(this._wmclass.toLowerCase())) return;
        if(this._scmd.type) {
            this._runWithJS(this._scmd.command, this._scmd.popup, this._scmd.copy, this._scmd.commit, this._scmd.select);
        } else {
            this._runWithSh(this._scmd.command, this._scmd.popup, this._scmd.copy, this._scmd.commit, this._scmd.select);
        }
    }

    _popup() {
        this._box._hide();
        this._bar._show(this._wmclass, this._selection);
    }

    Swift(word) {
        if(word) {
            this._store(word).then(this._swift.bind(this));
        } else {
            this._fetch().then(this._store.bind(this)).then(this._swift.bind(this));
        }
    }

    Popup(word) {
        if(word) {
            this._store(word).then(this._popup.bind(this));
        } else {
            this._fetch().then(this._store.bind(this)).then(this._popup.bind(this));
        }
    }

    Toggle() {
        let next = (this.trigger + 1) % 2;
        Main.notify(Me.metadata.name, _('Switch to %s mode').format(_(Object.keys(TriggerType)[next])));
        this.trigger = next;
    }

    Block() {
        if(!this._wmclass) return;
        if(!this.wmlist) {
            this.wmlist = this._wmclass;
        } else {
            let wmlist = this.wmlist.split(',');
            if(this.wmlist.includes(this._wmclass)) {
                wmlist.splice(wmlist.indexOf(this._wmclass), 1);
            } else {
                wmlist.push(this._wmclass);
            }
            this.wmlist = wmlist.join(',');
        }
    }

    destroy() {
        if(this.scommandsId)
            gsettings.disconnect(this.scommandsId), this.scommandsId = 0;
        if(this._mouseReleasedId)
            GLib.source_remove(this._mouseReleasedId), this._mouseReleasedId = 0;
        if(this._onWindowChangedId)
            global.display.disconnect(this._onWindowChangedId), this._onWindowChangedId = 0;
        if(this._onSelectChangedId)
            global.display.get_selection().disconnect(this._onSelectChangedId), this._onSelectChangedId = 0;

        this.systray = false;
        this._dbus.flush();
        this._dbus.unexport();
        this._bar.destroy();
        this._box.destroy();
        this._act.destroy();
        delete this._dbus;
        delete this._bar;
        delete this._box;
        delete this._act;
        super.destroy();
    }
});

const Extension = class Extension {
    constructor() {
        ExtensionUtils.initTranslations();
    }

    enable() {
        this._dict = new LightDict();
    }

    disable() {
        this._dict.destroy();
        delete this._dict;
    }
};

function init() {
    return new Extension();
}

