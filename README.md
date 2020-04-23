# Light Dict
Lightweight selection-popup extension of Gnome Shell with icon bar and tooltips-style panel, especially optimized for Dictionary.

>L, you know what? The Death eats apples only. —— *Light Yagami*<br>
[![license]](/LICENSE)

<br>

## Installation
[<img src="https://raw.githubusercontent.com/andyholmes/gnome-shell-extensions-badge/master/get-it-on-ego.svg?sanitize=true" alt="Get it on GNOME Extensions" height="100" align="middle">][EGO]

or manually:
```
git clone git@github.com:tuberry/light-dict.git
cp -r ./light-dict/light-dict@tuberry.github.io ~/.local/share/gnome-shell/extensions/
```

## Usage

The inspiration comes from two lovely extensions, [SSS](https://github.com/CanisLupus/swift-selection-search) and [youdaodict](https://github.com/HalfdogStudio/youdaodict), in Firefox and I always desire to use them outside browser.

![Screencast from 04-23-2020 04 55 32 PM](https://user-images.githubusercontent.com/17917040/80081294-574c8a80-8585-11ea-9b74-64b32d973425.gif)

*NOTE* This extension comes with absolutely no warranty and is published under GPLv3.0, also it doesn't offer any icons or dictionary resources though it's named Light Dict. If you have any questions about the usage, feel free to open an issue for discussion.

## Aknowledgements
* [youdaodict](https://github.com/HalfdogStudio/youdaodict): idea of popup panel
* [ibusCandidatePopup.js](https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/master/js/ui/ibusCandidatePopup.js): usage of boxpointer
* [swift-selection-search](https://github.com/CanisLupus/swift-selection-search): stylesheet of iconbar
* [clipboard-indicator](https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator): some UI widgets of prefs page
* [gsconnect](https://github.com/andyholmes/gnome-shell-extension-gsconnect): fake keyboard input

[EGO]:https://extensions.gnome.org/extension/2959/light-dict/
[license]:https://img.shields.io/badge/license-GPLv3-green.svg
