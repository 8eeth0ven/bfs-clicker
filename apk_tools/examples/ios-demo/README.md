# Owned iOS Simulator fixture

This is an installable UIKit query app for opt-in device acceptance. It has one
text field (`Query`), one query button (`Search`), and one result (`results`). A
query returns `RESULT:q=<current input>;COUNT:<actual button click count>`.
The app has no networking or credential paths. It uses UIKit scenes and supports
arm64 iOS Simulator builds; it is not an App Store archive or real-device IPA.

Build with the user's already configured and initialized Xcode:

```sh
.venv/bin/python apk_tools/examples/ios-demo/build_demo.py \
  --out output-vision-implementation/ios-demo/BFSMCPDemo.app
```

The builder does not accept licenses, change the selected developer directory,
install a runtime, use an Apple account, or access a signing private key. It uses
local `xcrun clang` and ad-hoc signing (`codesign --sign -`).

The real-device harness is `test/ios-device-e2e.mjs`. It expects a separately
installed, owned Appium prefix and registered XCUITest driver. The verified local
setup uses Appium 3.9.0 and `appium-xcuitest-driver` 12.22.3 under an ignored output
directory with its own `APPIUM_HOME`.

```sh
node test/ios-device-e2e.mjs --prepare-only \
  --appium-prefix /absolute/owned-appium-prefix \
  --output /absolute/new-preparation-output

node test/ios-device-e2e.mjs \
  --appium-prefix /absolute/owned-appium-prefix \
  --output /absolute/new-device-output
```

Preparation builds and signs the App, reads runtime availability, starts the real
owned Appium server to verify readiness, and stops it. It reports `prepared`,
never a device pass. The full run needs an available iOS simulator runtime; it
does not start a duplicate download.

The full run creates a new simulator UUID and uses real Appium → XCUITest → WDA.
A transparent HTTP forwarder records production commands and forwards actual
Appium responses; it generates no W3C fixture responses. The acceptance sequence
is raw `.app` extraction/discovery, automatic native candidate, two real samples,
unified MCP call, independent generated MCP call, a zero-command invalid-input
check, screenshot, and cleanup of its own session/Appium/App/simulator/ports.

The script independently compares the installed executable SHA on its own
simulator. The production WebDriver backend currently does not prove the
installed artifact hash, so its `appArtifactVerified:false` and associated gap
remain visible in the report. These are separate evidence scopes.
