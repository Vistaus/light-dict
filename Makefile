# by tuberry and based on dashtodock's makefile
# to increase version number automatically when manually installing

EXTNUM = 2959

UUID = $(shell ls | grep @)
NAME = $(shell cat $(UUID)/metadata.json | grep gettext-domain | sed -e 's/.* "//; s/".*//')
EGOURL = https://extensions.gnome.org/extension/$(EXTNUM)/$(subst gnome-shell-extension-,,$(NAME))/

BUILD = _build

# for translators: `make mergepo` or `make LANG=YOUR_LANG mergepo`
# The envvar LANG is used to localize pot file.
#
LANGUAGE = $(shell echo $(LANG) | sed -e 's/\..*//')
MSGDIR = $(UUID)/locale/$(LANGUAGE)/LC_MESSAGES
MSGPOT = $(UUID)/locale/$(NAME).pot
MSGAIM = $(MSGDIR)/$(NAME).po

ifeq ($(strip $(DESTDIR)),)
	INSTALLTYPE = local
	INSTALLBASE = $(HOME)/.local/share/gnome-shell/extensions
else
	INSTALLTYPE = system
	SHARE_PREFIX = $(DESTDIR)/usr/share
	INSTALLBASE = $(SHARE_PREFIX)/gnome-shell/extensions
endif

# The command line passed variable VERSION is used to set the version string
# in the metadata and in the generated zip-file. If no VERSION is passed, the
# max version on E.G.O plus 1 is used. (It could take some time to visit)
#
ifndef VERSION
	VERSION = $(shell curl -s $(EGOURL) 2>&1 | grep data-svm | sed -e 's/.*: //; s/}}"//' | xargs -I{} expr {} + 1)
endif

all: $(BUILD)

clean:
	-rm -fR $(BUILD)
	-rm -fR *.zip

$(BUILD):
	mkdir -p $(BUILD)
	cp -rf $(UUID)/* $(BUILD)
	sed -i 's/"version": [[:digit:]]\+/"version": $(VERSION)/' $(BUILD)/metadata.json;
	if test -d $(BUILD)/locale; then for p in $(BUILD)/locale/*/LC_MESSAGES/*.po; do msgfmt -o $${p/.po/.mo} $$p; done; fi;
	-rm -fR $(BUILD)/locale/*/LC_MESSAGES/*po
	glib-compile-schemas $(BUILD)/schemas/
	-rm -fR $(BUILD)/schemas/*xml

pack: $(BUILD)
	cd $(BUILD); \
		zip -qr "$(NAME)_v$(shell cat $(BUILD)/metadata.json | grep \"version\" | sed -e 's/[^0-9]*//').zip" .
	mv $(BUILD)/*.zip ./

install: $(BUILD)
	rm -fR $(INSTALLBASE)/$(UUID)
	mkdir -p $(INSTALLBASE)/$(UUID)
	cp -r $(BUILD)/* $(INSTALLBASE)/$(UUID)/
ifeq ($(INSTALLTYPE),system)
	# system-wide settings and locale files
	rm -r $(INSTALLBASE)/$(UUID)/schemas $(INSTALLBASE)/$(UUID)/locale
	mkdir -p $(SHARE_PREFIX)/glib-2.0/schemas $(SHARE_PREFIX)/locale
	cp -r $(UUID)/schemas/*gschema.xml $(SHARE_PREFIX)/glib-2.0/schemas
	cd $(BUILD)/locale; \
		cp --parents */LC_MESSAGES/*.mo $(SHARE_PREFIX)/locale
endif

$(MSGAIM):
	mkdir -p $(MSGDIR); \
		msginit --no-translator -l $(LANGUAGE).UTF-8 -i $(MSGPOT) -o $(MSGAIM)

$(MSGPOT):
	cd $(UUID); \
		xgettext --keyword=_ --from-code=utf-8 --package-name="$(NAME)" --package-version=$(VERSION) --add-comments='Translators:' --output locale/$(NAME).pot *js

mergepo: $(MSGPOT) $(MSGAIM)
	msgmerge -U $(MSGAIM) $(MSGPOT)
	-rm -fR $(MSGPOT)
	-rm -fR $(MSGDIR)/*po~
