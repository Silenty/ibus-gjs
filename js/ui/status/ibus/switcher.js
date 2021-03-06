// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/*
 * Copyright 2012 Red Hat, Inc.
 * Copyright 2012 Peng Huang <shawn.p.huang@gmail.com>
 * Copyright 2012 Takao Fujiwara <tfujiwar@redhat.com>
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as
 * published by the Free Software Foundation, either version 2.1 of
 * the License, or (at your option) any later version.
 *
 * This program is distributed in the hope it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE.  See the GNU Lesser General Public License for
 * more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

const Clutter = imports.gi.Clutter;
const Gio  = imports.gi.Gio;
const Pango = imports.gi.Pango;
const IBus = imports.gi.IBus;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const St = imports.gi.St;

const Main = imports.ui.main;
const Tweener = imports.ui.tweener;

const POPUP_APPICON_SIZE = 96;
const POPUP_SCROLL_TIME = 0.10; // seconds
const POPUP_DELAY_TIMEOUT = 150; // milliseconds
const POPUP_FADE_OUT_TIME = 0.1; // seconds

const APP_ICON_HOVER_TIMEOUT = 200; // milliseconds

const DISABLE_HOVER_TIMEOUT = 500; // milliseconds

const THUMBNAIL_DEFAULT_SIZE = 256;
const THUMBNAIL_POPUP_TIME = 500; // milliseconds
const THUMBNAIL_FADE_TIME = 0.1; // seconds

const iconSizes = [96, 64, 48, 32, 22];

function mod(a, b) {
    return (a + b) % b;
}

function primaryModifier(mask) {
    if (mask == 0)
        return 0;

    let primary = 1;
    while (mask > 1) {
        mask >>= 1;
        primary <<= 1;
    }
    return primary;
}

const Switcher = new Lang.Class({
    Name: 'Switcher',

    _init : function(panel, keybindings) {
        this.panel = panel;
        this._keybindings = keybindings;
        this.actor = new Shell.GenericContainer({ name: 'switcher',
                                                  reactive: true,
                                                  visible: false });

        this.actor.connect('get-preferred-width', Lang.bind(this, this._getPreferredWidth));
        this.actor.connect('get-preferred-height', Lang.bind(this, this._getPreferredHeight));
        this.actor.connect('allocate', Lang.bind(this, this._allocate));

        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));

        this._haveModal = false;
        this._modifierMask = 0;

        this._currentApp = 0;
        this._motionTimeoutId = 0;
        this._initialDelayTimeoutId = 0;

        this._engines = [];

        // Initially disable hover so we ignore the enter-event if
        // the switcher appears underneath the current pointer location
        this._disableHover();

        Main.uiGroup.add_child(this.actor);
    },

    _getPreferredWidth: function (actor, forHeight, alloc) {
        alloc.min_size = global.screen_width;
        alloc.natural_size = global.screen_width;
    },

    _getPreferredHeight: function (actor, forWidth, alloc) {
        alloc.min_size = global.screen_height;
        alloc.natural_size = global.screen_height;
    },

    _allocate: function (actor, box, flags) {
        let childBox = new Clutter.ActorBox();
        let primary = Main.layoutManager.primaryMonitor;

        let leftPadding = this.actor.get_theme_node().get_padding(St.Side.LEFT);
        let rightPadding = this.actor.get_theme_node().get_padding(St.Side.RIGHT);
        let bottomPadding = this.actor.get_theme_node().get_padding(St.Side.BOTTOM);
        let vPadding = this.actor.get_theme_node().get_vertical_padding();
        let hPadding = leftPadding + rightPadding;

        // Allocate the appSwitcher
        // We select a size based on an icon size that does not overflow the screen
        if (this._appSwitcher == null) {
            return;
        }
        let [childMinHeight, childNaturalHeight] = this._appSwitcher.actor.get_preferred_height(primary.width - hPadding);
        let [childMinWidth, childNaturalWidth] = this._appSwitcher.actor.get_preferred_width(childNaturalHeight);
        childBox.x1 = Math.max(primary.x + leftPadding, primary.x + Math.floor((primary.width - childNaturalWidth) / 2));
        childBox.x2 = Math.min(primary.x + primary.width - rightPadding, childBox.x1 + childNaturalWidth);
        childBox.y1 = primary.y + Math.floor((primary.height - childNaturalHeight) / 2);
        childBox.y2 = childBox.y1 + childNaturalHeight;
        this._appSwitcher.actor.allocate(childBox, flags);

        // Allocate the thumbnails
        // We try to avoid overflowing the screen so we base the resulting size on
        // those calculations
        if (this._thumbnails) {
            let icon = this._appIcons[this._currentApp].actor;
            let [posX, posY] = icon.get_transformed_position();
            let thumbnailCenter = posX + icon.width / 2;
            let [childMinWidth, childNaturalWidth] = this._thumbnails.actor.get_preferred_width(-1);
            childBox.x1 = Math.max(primary.x + leftPadding, Math.floor(thumbnailCenter - childNaturalWidth / 2));
            if (childBox.x1 + childNaturalWidth > primary.x + primary.width - hPadding) {
                let offset = childBox.x1 + childNaturalWidth - primary.width + hPadding;
                childBox.x1 = Math.max(primary.x + leftPadding, childBox.x1 - offset - hPadding);
            }

            let spacing = this.actor.get_theme_node().get_length('spacing');

            childBox.x2 = childBox.x1 +  childNaturalWidth;
            if (childBox.x2 > primary.x + primary.width - rightPadding)
                childBox.x2 = primary.x + primary.width - rightPadding;
            childBox.y1 = this._appSwitcher.actor.allocation.y2 + spacing;
            this._thumbnails.addClones(primary.height - bottomPadding - childBox.y1);
            let [childMinHeight, childNaturalHeight] = this._thumbnails.actor.get_preferred_height(-1);
            childBox.y2 = childBox.y1 + childNaturalHeight;
            this._thumbnails.actor.allocate(childBox, flags);
        }
    },

    show : function(engines, mask) {

        if (engines.length <= 1) {
            return false;
        }

        this._engines = engines;

        if (!Main.pushModal(this.actor)) {
            // Probably someone else has a pointer grab, try again with keyboard only
            if (!Main.pushModal(this.actor, global.get_current_time(), Meta.ModalOptions.POINTER_ALREADY_GRABBED)) {
                return false;
            }
        }
        this._haveModal = true;
        this._modifierMask = primaryModifier(mask);

        this.actor.connect('key-press-event',
                           Lang.bind(this, this._keyPressEventHandler));
        this.actor.connect('key-release-event',
                           Lang.bind(this, this._keyReleaseEventHandler));

        this.actor.connect('button-press-event',
                           Lang.bind(this, this._clickedOutside));
        this.actor.connect('scroll-event', Lang.bind(this, this._onScroll));

        this._appSwitcher = new EngineSwitcher(engines, this);
        this.actor.add_child(this._appSwitcher.actor);
        this._appSwitcher.connect('item-activated',
                                  Lang.bind(this, this._appActivated));
        this._appSwitcher.connect('item-entered',
                                  Lang.bind(this, this._appEntered));

        this._appIcons = this._appSwitcher.icons;

        // Need to force an allocation so we can figure out whether we
        // need to scroll when selecting
        this.actor.opacity = 0;
        this.actor.show();
        this.actor.get_allocation_box();

        // Make the initial selection
        this._select(1);

        // There's a race condition; if the user released Alt before
        // we got the grab, then we won't be notified. (See
        // https://bugzilla.gnome.org/show_bug.cgi?id=596695 for
        // details.) So we check now. (Have to do this after updating
        // selection.)
        let [x, y, mods] = global.get_pointer();
        if (!(mods & this._modifierMask)) {
            this._finish();
            return false;
        }

        // We delay showing the popup so that fast Alt+Tab users aren't
        // disturbed by the popup briefly flashing.
        this._initialDelayTimeoutId = Mainloop.timeout_add(POPUP_DELAY_TIMEOUT,
                                                           Lang.bind(this, function () {
                                                               this.actor.opacity = 255;
                                                               this._initialDelayTimeoutId = 0;
                                                           }));

        return true;
    },

    _nextApp : function() {
        return mod(this._currentApp + 1, this._appIcons.length);
    },

    _previousApp : function() {
        return mod(this._currentApp - 1, this._appIcons.length);
    },

    keyPressEvent : function(event) {
        let keysym = event.get_key_symbol();
        let ignoredModifiers = global.display.get_ignored_modifier_mask();
        let eventState = event.get_state()
            & IBus.ModifierType.MODIFIER_MASK
            & ~ignoredModifiers;
        let isTrigger = false;

        this._disableHover();

        let i = 0;
        for (; i < this._keybindings.length; i++) {
            if (this._keybindings[i].keysym == keysym &&
                this._keybindings[i].modifiers == eventState) {
                isTrigger = true;
                break;
            }
        }

        if (isTrigger) {
            this._select(this._keybindings[i].reverse ?
                         this._previousApp() : this._nextApp());
            return true;
        }

        // Cancel the switcher if another key is pressed with pressing Ctrl.
        this.destroy();
        return false;
    },

    keyReleaseEvent : function(event) {
        let [x, y, mods] = global.get_pointer();
        let state = mods & this._modifierMask;

        if (state == 0) {
            this._finish();
            return true;
        }
        return false;
    },

    _keyPressEventHandler : function(actor, event) {
        return this.keyPressEvent(event);
    },

    _keyReleaseEventHandler : function(actor, event) {
        return this.keyReleaseEvent(event);
    },

    _onScroll : function(actor, event) {
        let direction = event.get_scroll_direction();
        if (direction == Clutter.ScrollDirection.UP) {
            this._select(this._previousApp());
        } else if (direction == Clutter.ScrollDirection.DOWN) {
            this._select(this._nextApp());
        }
    },

    _clickedOutside : function(actor, event) {
        this.destroy();
    },

    _appActivated : function(appSwitcher, n) {
        let icon = this._appIcons[n];
        this.emit('engine-activated', icon.engine.get_name());
        this.destroy();
    },

    _appEntered : function(appSwitcher, n) {
        if (!this._mouseActive)
            return;

        this._select(n);
    },

    _disableHover : function() {
        this._mouseActive = false;

        if (this._motionTimeoutId != 0)
            Mainloop.source_remove(this._motionTimeoutId);

        this._motionTimeoutId = Mainloop.timeout_add(DISABLE_HOVER_TIMEOUT, Lang.bind(this, this._mouseTimedOut));
    },

    _mouseTimedOut : function() {
        this._motionTimeoutId = 0;
        this._mouseActive = true;
    },

    _finish : function() {
        let icon = this._appIcons[this._currentApp];
        this.emit('engine-activated', icon.engine.get_name());
        this.destroy();
    },

    _popModal: function() {
        if (this._haveModal) {
            Main.popModal(this.actor);
            this._haveModal = false;
        }
    },

    destroy : function() {
        this._popModal();
        if (this.actor.visible) {
            Tweener.addTween(this.actor,
                             { opacity: 0,
                               time: POPUP_FADE_OUT_TIME,
                               transition: 'easeOutQuad',
                               onComplete: Lang.bind(this,
                                   function() {
                                       this.actor.destroy();
                                   })
                             });
        } else
            this.actor.destroy();
    },

    _onDestroy : function() {
        this._popModal();

        if (this._thumbnails)
            this._destroyThumbnails();

        if (this._motionTimeoutId != 0)
            Mainloop.source_remove(this._motionTimeoutId);
        if (this._initialDelayTimeoutId != 0)
            Mainloop.source_remove(this._initialDelayTimeoutId);
    },

    /**
     * _select:
     * @app: index of the app to select
     *
     * Selects the indicated @app to indicate whether the
     * arrow keys should act on the app list.
     *
     * If @app is specified, then
     * the app is highlighted (ie, given a light background), and the
     * current thumbnail list, if any, is destroyed.
     */
    _select : function(app) {
        this._currentApp = app;
        this._appSwitcher.highlight(app);
    }
});

Signals.addSignalMethods(Switcher.prototype);

const SwitcherList = new Lang.Class({
    Name: 'SwitcherList',

    _init : function(squareItems) {
        this.actor = new Shell.GenericContainer({ style_class: 'switcher-list' });
        this.actor.connect('get-preferred-width', Lang.bind(this, this._getPreferredWidth));
        this.actor.connect('get-preferred-height', Lang.bind(this, this._getPreferredHeight));
        this.actor.connect('allocate', Lang.bind(this, this._allocateTop));

        // Here we use a GenericContainer so that we can force all the
        // children except the separator to have the same width.
        this._list = new Shell.GenericContainer({ style_class: 'switcher-list-item-container' });
        this._list.spacing = 0;
        this._list.connect('style-changed', Lang.bind(this, function() {
                                                        this._list.spacing = this._list.get_theme_node().get_length('spacing');
                                                     }));

        this._list.connect('get-preferred-width', Lang.bind(this, this._getPreferredWidth));
        this._list.connect('get-preferred-height', Lang.bind(this, this._getPreferredHeight));
        this._list.connect('allocate', Lang.bind(this, this._allocate));

        this._clipBin = new St.Bin({style_class: 'cbin'});
        this._clipBin.child = this._list;
        this.actor.add_child(this._clipBin);

        this._leftGradient = new St.BoxLayout({style_class: 'thumbnail-scroll-gradient-left', vertical: true});
        this._rightGradient = new St.BoxLayout({style_class: 'thumbnail-scroll-gradient-right', vertical: true});
        this.actor.add_child(this._leftGradient);
        this.actor.add_child(this._rightGradient);

        // Those arrows indicate whether scrolling in one direction is possible
        this._leftArrow = new St.DrawingArea({ style_class: 'switcher-arrow',
                                               pseudo_class: 'highlighted' });
        this._leftArrow.connect('repaint', Lang.bind(this,
            function() { _drawArrow(this._leftArrow, St.Side.LEFT); }));
        this._rightArrow = new St.DrawingArea({ style_class: 'switcher-arrow',
                                                pseudo_class: 'highlighted' });
        this._rightArrow.connect('repaint', Lang.bind(this,
            function() { _drawArrow(this._rightArrow, St.Side.RIGHT); }));

        this.actor.add_child(this._leftArrow);
        this.actor.add_child(this._rightArrow);

        this._items = [];
        this._highlighted = -1;
        this._separator = null;
        this._squareItems = squareItems;
        this._minSize = 0;
        this._scrollableRight = true;
        this._scrollableLeft = false;
    },

    _allocateTop: function(actor, box, flags) {
        let leftPadding = this.actor.get_theme_node().get_padding(St.Side.LEFT);
        let rightPadding = this.actor.get_theme_node().get_padding(St.Side.RIGHT);

        let childBox = new Clutter.ActorBox();
        let scrollable = this._minSize > box.x2 - box.x1;

        this._clipBin.allocate(box, flags);

        childBox.x1 = 0;
        childBox.y1 = 0;
        childBox.x2 = this._leftGradient.width;
        childBox.y2 = this.actor.height;
        this._leftGradient.allocate(childBox, flags);
        this._leftGradient.opacity = (this._scrollableLeft && scrollable) ? 255 : 0;

        childBox.x1 = (this.actor.allocation.x2 - this.actor.allocation.x1) - this._rightGradient.width;
        childBox.y1 = 0;
        childBox.x2 = childBox.x1 + this._rightGradient.width;
        childBox.y2 = this.actor.height;
        this._rightGradient.allocate(childBox, flags);
        this._rightGradient.opacity = (this._scrollableRight && scrollable) ? 255 : 0;

        let arrowWidth = Math.floor(leftPadding / 3);
        let arrowHeight = arrowWidth * 2;
        childBox.x1 = leftPadding / 2;
        childBox.y1 = this.actor.height / 2 - arrowWidth;
        childBox.x2 = childBox.x1 + arrowWidth;
        childBox.y2 = childBox.y1 + arrowHeight;
        this._leftArrow.allocate(childBox, flags);
        this._leftArrow.opacity = this._leftGradient.opacity;

        arrowWidth = Math.floor(rightPadding / 3);
        arrowHeight = arrowWidth * 2;
        childBox.x1 = this.actor.width - arrowWidth - rightPadding / 2;
        childBox.y1 = this.actor.height / 2 - arrowWidth;
        childBox.x2 = childBox.x1 + arrowWidth;
        childBox.y2 = childBox.y1 + arrowHeight;
        this._rightArrow.allocate(childBox, flags);
        this._rightArrow.opacity = this._rightGradient.opacity;
    },

    addItem : function(item, label) {
        let bbox = new St.Button({ style_class: 'item-box',
                                   reactive: true });

        bbox.set_child(item);
        this._list.add_child(bbox);

        let n = this._items.length;
        bbox.connect('clicked', Lang.bind(this, function() { this._onItemClicked(n); }));
        bbox.connect('enter-event', Lang.bind(this, function() { this._onItemEnter(n); }));

        bbox.label_actor = label;

        this._items.push(bbox);
    },

    _onItemClicked: function (index) {
        this._itemActivated(index);
    },

    _onItemEnter: function (index) {
        this._itemEntered(index);
    },

    addSeparator: function () {
        let box = new St.Bin({ style_class: 'separator' });
        this._separator = box;
        this._list.add_child(box);
    },

    highlight: function(index) {
        if (this._highlighted != -1) {
            this._items[this._highlighted].remove_style_pseudo_class('outlined');
            this._items[this._highlighted].remove_style_pseudo_class('selected');
        }

        this._highlighted = index;

        if (this._highlighted != -1) {
            this._items[this._highlighted].add_style_pseudo_class('selected');
        }

        let [absItemX, absItemY] = this._items[index].get_transformed_position();
        let [result, posX, posY] = this.actor.transform_stage_point(absItemX, 0);
        let [containerWidth, containerHeight] = this.actor.get_transformed_size();
        if (posX + this._items[index].get_width() > containerWidth)
            this._scrollToRight();
        else if (posX < 0)
            this._scrollToLeft();
    },

    _scrollToLeft : function() {
        let x = this._items[this._highlighted].allocation.x1;
        this._scrollableRight = true;
        Tweener.addTween(this._list, { anchor_x: x,
                                        time: POPUP_SCROLL_TIME,
                                        transition: 'easeOutQuad',
                                        onComplete: Lang.bind(this, function () {
                                                                        if (this._highlighted == 0) {
                                                                            this._scrollableLeft = false;
                                                                            this.actor.queue_relayout();
                                                                        }
                                                             })
                        });
    },

    _scrollToRight : function() {
        this._scrollableLeft = true;
        let monitor = Main.layoutManager.primaryMonitor;
        let padding = this.actor.get_theme_node().get_horizontal_padding();
        let parentPadding = this.actor.get_parent().get_theme_node().get_horizontal_padding();
        let x = this._items[this._highlighted].allocation.x2 - monitor.width + padding + parentPadding;
        Tweener.addTween(this._list, { anchor_x: x,
                                        time: POPUP_SCROLL_TIME,
                                        transition: 'easeOutQuad',
                                        onComplete: Lang.bind(this, function () {
                                                                        if (this._highlighted == this._items.length - 1) {
                                                                            this._scrollableRight = false;
                                                                            this.actor.queue_relayout();
                                                                        }
                                                             })
                        });
    },

    _itemActivated: function(n) {
        this.emit('item-activated', n);
    },

    _itemEntered: function(n) {
        this.emit('item-entered', n);
    },

    _maxChildWidth: function (forHeight) {
        let maxChildMin = 0;
        let maxChildNat = 0;

        for (let i = 0; i < this._items.length; i++) {
            let [childMin, childNat] = this._items[i].get_preferred_width(forHeight);
            maxChildMin = Math.max(childMin, maxChildMin);
            maxChildNat = Math.max(childNat, maxChildNat);

            if (this._squareItems) {
                let [childMin, childNat] = this._items[i].get_preferred_height(-1);
                maxChildMin = Math.max(childMin, maxChildMin);
                maxChildNat = Math.max(childNat, maxChildNat);
            }
        }

        return [maxChildMin, maxChildNat];
    },

    _getPreferredWidth: function (actor, forHeight, alloc) {
        let [maxChildMin, maxChildNat] = this._maxChildWidth(forHeight);

        let separatorWidth = 0;
        if (this._separator) {
            let [sepMin, sepNat] = this._separator.get_preferred_width(forHeight);
            separatorWidth = sepNat + this._list.spacing;
        }

        let totalSpacing = this._list.spacing * (this._items.length - 1);
        alloc.min_size = this._items.length * maxChildMin + separatorWidth + totalSpacing;
        alloc.natural_size = alloc.min_size;
        this._minSize = alloc.min_size;
    },

    _getPreferredHeight: function (actor, forWidth, alloc) {
        let maxChildMin = 0;
        let maxChildNat = 0;

        for (let i = 0; i < this._items.length; i++) {
            let [childMin, childNat] = this._items[i].get_preferred_height(-1);
            maxChildMin = Math.max(childMin, maxChildMin);
            maxChildNat = Math.max(childNat, maxChildNat);
        }

        if (this._squareItems) {
            let [childMin, childNat] = this._maxChildWidth(-1);
            maxChildMin = Math.max(childMin, maxChildMin);
            maxChildNat = maxChildMin;
        }

        alloc.min_size = maxChildMin;
        alloc.natural_size = maxChildNat;
    },

    _allocate: function (actor, box, flags) {
        let childHeight = box.y2 - box.y1;

        let [maxChildMin, maxChildNat] = this._maxChildWidth(childHeight);
        let totalSpacing = this._list.spacing * (this._items.length - 1);

        let separatorWidth = 0;
        if (this._separator) {
            let [sepMin, sepNat] = this._separator.get_preferred_width(childHeight);
            separatorWidth = sepNat;
            totalSpacing += this._list.spacing;
        }

        let childWidth = Math.floor(Math.max(0, box.x2 - box.x1 - totalSpacing - separatorWidth) / this._items.length);

        let x = 0;
        let children = this._list.get_children();
        let childBox = new Clutter.ActorBox();

        let primary = Main.layoutManager.primaryMonitor;
        let parentRightPadding = this.actor.get_parent().get_theme_node().get_padding(St.Side.RIGHT);
        if (this.actor.allocation.x2 == primary.x + primary.width - parentRightPadding) {
            if (this._squareItems)
                childWidth = childHeight;
            else {
                let [childMin, childNat] = children[0].get_preferred_width(childHeight);
                childWidth = childMin;
            }
        }

        for (let i = 0; i < children.length; i++) {
            if (this._items.indexOf(children[i]) != -1) {
                let [childMin, childNat] = children[i].get_preferred_height(childWidth);
                let vSpacing = (childHeight - childNat) / 2;
                childBox.x1 = x;
                childBox.y1 = vSpacing;
                childBox.x2 = x + childWidth;
                childBox.y2 = childBox.y1 + childNat;
                children[i].allocate(childBox, flags);

                x += this._list.spacing + childWidth;
            } else if (children[i] == this._separator) {
                // We want the separator to be more compact than the rest.
                childBox.x1 = x;
                childBox.y1 = 0;
                childBox.x2 = x + separatorWidth;
                childBox.y2 = childHeight;
                children[i].allocate(childBox, flags);
                x += this._list.spacing + separatorWidth;
            } else {
                // Something else, eg, EngineSwitcher's arrows;
                // we don't allocate it.
            }
        }

        let leftPadding = this.actor.get_theme_node().get_padding(St.Side.LEFT);
        let rightPadding = this.actor.get_theme_node().get_padding(St.Side.RIGHT);
        let topPadding = this.actor.get_theme_node().get_padding(St.Side.TOP);
        let bottomPadding = this.actor.get_theme_node().get_padding(St.Side.BOTTOM);

        // Clip the area for scrolling
        this._clipBin.set_clip(0, -topPadding, (this.actor.allocation.x2 - this.actor.allocation.x1) - leftPadding - rightPadding, this.actor.height + bottomPadding);
    }
});

Signals.addSignalMethods(SwitcherList.prototype);

const EngineIcon = new Lang.Class({
    Name: 'EngineIcon',

    _init: function(engine, panel) {
        this.engine = engine;
        this._panel = panel;
        this.actor = new St.BoxLayout({ style_class: 'alt-tab-app',
                                         vertical: true });
        this._iconBin = new St.Bin({ x_fill: true, y_fill: true });

        let icon = null;
        if (this.engine.symbol != null) {
            let text = panel.getIconTextFromEngine(this.engine);
            icon = new St.Label({ text: text });
            let name = icon.clutter_text.get_font_name();
            let desc = Pango.FontDescription.from_string(name);
            this._themed_font_size = desc.get_size();

            /* Set StText.clutter_text.font_desc after EngineIcon.setSize()
             * is called. */
            icon.clutter_text.connect('paint', Lang.bind(this, function() {
                icon = this._iconBin.child;
                name = icon.clutter_text.get_font_name();
                desc = Pango.FontDescription.from_string(name);
                desc.set_size(this._themed_font_size * 4);
                icon.clutter_text.set_font_description(desc);
            }));
        } else {
            icon = new St.Icon({ icon_name: engine.icon,
                                 icon_type: St.IconType.SYMBOLIC });
        }
        if (icon != null) {
            this._iconBin.child = icon
        }

        this.actor.add_child(this._iconBin, { x_fill: false, y_fill: false } );
        this.label = new St.Label({ text: this.engine.get_longname() });
        this.actor.add_child(this.label, { x_fill: false });
    },

    setSize: function(size) {
        this._iconBin.set_size(size, size);
    }
});

const EngineSwitcher = new Lang.Class({
    Name: 'EngineSwitcher',
    Extends: SwitcherList,

    _init : function(engines, frame) {
        this._frame = frame;
        this.parent(true);

        // Construct the EngineIcons, add to the popup
        let workspaceIcons = [];
        for (let i = 0; i < engines.length; i++) {
            let engineIcon = new EngineIcon(engines[i], this._frame.panel);
            // Cache the window list now; we don't handle dynamic changes here,
            // and we don't want to be continually retrieving it
            //engineIcon.cachedWindows = engineIcon.engine.get_windows();
            workspaceIcons.push(engineIcon);
        }

        this.icons = [];
        for (let i = 0; i < workspaceIcons.length; i++)
            this._addIcon(workspaceIcons[i]);

        this._curApp = -1;
        this._iconSize = 0;
        this._mouseTimeOutId = 0;
    },

    _getPreferredHeight: function (actor, forWidth, alloc) {
        let j = 0;
        while(this._items.length > 1 && this._items[j].style_class != 'item-box') {
                j++;
        }
        let themeNode = this._items[j].get_theme_node();
        let iconPadding = themeNode.get_horizontal_padding();
        let iconBorder = themeNode.get_border_width(St.Side.LEFT) + themeNode.get_border_width(St.Side.RIGHT);
        let [iconMinHeight, iconNaturalHeight] = this.icons[j].label.get_preferred_height(-1);
        let iconSpacing = iconNaturalHeight + iconPadding + iconBorder;
        let totalSpacing = this._list.spacing * (this._items.length - 1);
        if (this._separator)
           totalSpacing += this._separator.width + this._list.spacing;

        // We just assume the whole screen here due to weirdness happing with the passed width
        let primary = Main.layoutManager.primaryMonitor;
        let parentPadding = this.actor.get_parent().get_theme_node().get_horizontal_padding();
        let availWidth = primary.width - parentPadding - this.actor.get_theme_node().get_horizontal_padding();
        let height = 0;

        for(let i =  0; i < iconSizes.length; i++) {
                this._iconSize = iconSizes[i];
                height = iconSizes[i] + iconSpacing;
                let w = height * this._items.length + totalSpacing;
                if (w <= availWidth)
                        break;
        }

        if (this._items.length == 1) {
            this._iconSize = iconSizes[0];
            height = iconSizes[0] + iconSpacing;
        }

        for(let i = 0; i < this.icons.length; i++) {
            if (this.icons[i].icon != null)
                break;
            this.icons[i].setSize(this._iconSize);
        }

        alloc.min_size = height;
        alloc.natural_size = height;
    },

    _allocate: function (actor, box, flags) {
        // Allocate the main list items
        this.parent(actor, box, flags);
    },

    // We override SwitcherList's _onItemEnter method to delay
    // activation when the thumbnail list is open
    _onItemEnter: function (index) {
        if (this._mouseTimeOutId != 0)
            Mainloop.source_remove(this._mouseTimeOutId);
        if (this._frame.thumbnailsVisible) {
            this._mouseTimeOutId = Mainloop.timeout_add(APP_ICON_HOVER_TIMEOUT,
                                                        Lang.bind(this, function () {
                                                                            this._enterItem(index);
                                                                            this._mouseTimeOutId = 0;
                                                                            return false;
                                                        }));
        } else
           this._itemEntered(index);
    },

    _enterItem: function(index) {
        let [x, y, mask] = global.get_pointer();
        let pickedActor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);
        if (this._items[index].contains(pickedActor))
            this._itemEntered(index);
    },

    highlight : function(n) {
        this.parent(n);
        this._curApp = n;
    },

    _addIcon : function(appIcon) {
        this.icons.push(appIcon);
        this.addItem(appIcon.actor, appIcon.label);
    }
});

const ThumbnailList = new Lang.Class({
    Name: 'ThumbnailList',
    Extends: SwitcherList,

    _init : function(windows) {
        this.parent(false);

        let activeWorkspace = global.screen.get_active_workspace();

        // We fake the value of 'separatorAdded' when the app has no window
        // on the current workspace, to avoid displaying a useless separator in
        // that case.
        let separatorAdded = windows.length == 0 || windows[0].get_workspace() != activeWorkspace;

        this._labels = new Array();
        this._thumbnailBins = new Array();
        this._clones = new Array();
        this._windows = windows;

        for (let i = 0; i < windows.length; i++) {
            if (!separatorAdded && windows[i].get_workspace() != activeWorkspace) {
              this.addSeparator();
              separatorAdded = true;
            }

            let box = new St.BoxLayout({ style_class: 'thumbnail-box',
                                         vertical: true });

            let bin = new St.Bin({ style_class: 'thumbnail' });

            box.add_child(bin);
            this._thumbnailBins.push(bin);

            let title = windows[i].get_title();
            if (title) {
                let name = new St.Label({ text: title });
                // St.Label doesn't support text-align so use a Bin
                let bin = new St.Bin({ x_align: St.Align.MIDDLE });
                this._labels.push(bin);
                bin.add_child(name);
                box.add_child(bin);

                this.addItem(box, name);
            } else {
                this.addItem(box, null);
            }

        }
    },

    addClones : function (availHeight) {
        if (!this._thumbnailBins.length)
            return;
        let totalPadding = this._items[0].get_theme_node().get_horizontal_padding() + this._items[0].get_theme_node().get_vertical_padding();
        totalPadding += this.actor.get_theme_node().get_horizontal_padding() + this.actor.get_theme_node().get_vertical_padding();
        let [labelMinHeight, labelNaturalHeight] = this._labels[0].get_preferred_height(-1);
        let spacing = this._items[0].child.get_theme_node().get_length('spacing');

        availHeight = Math.min(availHeight - labelNaturalHeight - totalPadding - spacing, THUMBNAIL_DEFAULT_SIZE);
        let binHeight = availHeight + this._items[0].get_theme_node().get_vertical_padding() + this.actor.get_theme_node().get_vertical_padding() - spacing;
        binHeight = Math.min(THUMBNAIL_DEFAULT_SIZE, binHeight);

        for (let i = 0; i < this._thumbnailBins.length; i++) {
            let mutterWindow = this._windows[i].get_compositor_private();
            if (!mutterWindow)
                continue;

            let windowTexture = mutterWindow.get_texture ();
            let [width, height] = windowTexture.get_size();
            let scale = Math.min(1.0, THUMBNAIL_DEFAULT_SIZE / width, availHeight / height);
            let clone = new Clutter.Clone ({ source: windowTexture,
                                                reactive: true,
                                                width: width * scale,
                                                height: height * scale });

            this._thumbnailBins[i].set_height(binHeight);
            this._thumbnailBins[i].add_child(clone);
            this._clones.push(clone);
        }

        // Make sure we only do this once
        this._thumbnailBins = new Array();
    }
});

function _drawArrow(area, side) {
    let themeNode = area.get_theme_node();
    let borderColor = themeNode.get_border_color(side);
    let bodyColor = themeNode.get_foreground_color();

    let [width, height] = area.get_surface_size ();
    let cr = area.get_context();

    cr.setLineWidth(1.0);
    Clutter.cairo_set_source_color(cr, borderColor);

    switch (side) {
    case St.Side.TOP:
        cr.moveTo(0, height);
        cr.lineTo(Math.floor(width * 0.5), 0);
        cr.lineTo(width, height);
        break;

    case St.Side.BOTTOM:
        cr.moveTo(width, 0);
        cr.lineTo(Math.floor(width * 0.5), height);
        cr.lineTo(0, 0);
        break;

    case St.Side.LEFT:
        cr.moveTo(width, height);
        cr.lineTo(0, Math.floor(height * 0.5));
        cr.lineTo(width, 0);
        break;

    case St.Side.RIGHT:
        cr.moveTo(0, 0);
        cr.lineTo(width, Math.floor(height * 0.5));
        cr.lineTo(0, height);
        break;
    }

    cr.strokePreserve();

    Clutter.cairo_set_source_color(cr, bodyColor);
    cr.fill();
}
