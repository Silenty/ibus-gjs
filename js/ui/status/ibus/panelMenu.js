/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */
/*
 * Copyright 2011 Red Hat, Inc.
 * Copyright 2011 Peng Huang <shawn.p.huang@gmail.com>
 * Copyright 2011 Takao Fujiwara <tfujiwar@redhat.com>
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
const St = imports.gi.St;
const Lang = imports.lang;
const PanelMenu = imports.ui.panelMenu;
const Main = imports.ui.main;

const PopupMenu = imports.ui.status.ibus.popupMenu;


function SystemStatusLabelButton(label, iconName, tooltipText) {
    this._init(label, iconName, tooltipText);
}

/* We'd like to show both icon and label. */
SystemStatusLabelButton.prototype = {
    __proto__: PanelMenu.Button.prototype,

    _init: function(label, iconName, tooltipText) {
        PanelMenu.Button.prototype._init.call(this, 0.0);
        this._initMenu();
        this._iconActor = null;
        this._iconName = null;
        this._iconActor = null;
        this._label = null;
        this._labelActor = null;
        if (label != null) {
            this.setLabel(label);
        } else {
            this.setIcon(iconName);
        }
        this.setTooltip(tooltipText);
    },

    /* The custom PopupMenu does not emit open-state-changed so that
     * the focus is kept on the text applications. */
    _initMenu: function() {
        if (this.menu) {
            this.menu.close();
        }
        this.menu = new PopupMenu.PopupMenuNoOpenStateChanged(this.actor,
                                                              St.Align.START,
                                                              St.Side.TOP);
        this.menu.actor.add_style_class_name('panel-menu');
        Main.uiGroup.add_actor(this.menu.actor);
        this.menu.actor.hide();
    },

    setIcon: function(iconName) {
        this._iconName = iconName;
        if (this._iconActor)
            this._iconActor.destroy();
        this._iconActor = new St.Icon({ icon_name: iconName,
                                        icon_type: St.IconType.SYMBOLIC,
                                        style_class: 'system-status-icon' });
        this.actor.set_child(null);
        this.actor.set_child(this._iconActor);
        this.actor.queue_redraw();
    },

    setLabel: function(label) {
        this._label = label;
        if (this._labelActor)
            this._labelActor.destroy();
        this._labelActor = new St.Label({ text: label });
        this.actor.set_child(null);
        this.actor.set_child(this._labelActor);
        this.actor.queue_redraw();
    },

    setTooltip: function(text) {
        if (text != null) {
            this.tooltip = text;
            this.actor.has_tooltip = true;
            this.actor.tooltip_text = text;
        } else {
            this.actor.has_tooltip = false;
            this.tooltip = null;
        }
    }
};
