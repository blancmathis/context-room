# Android source and dependencies

The retained native canvas, its raster caches and the optional BOOX adapter
were selectively brought into Context Room from the author's Lisière code.
They now use Context Room's notebook protocol and portable durable client.
The import contains no application data, credential, updater or private Git
history.

The Gradle wrapper is a Gradle 8.11.1 build tool, distributed under Apache-2.0;
its launchers retain the upstream license notice. Its distribution checksum
is pinned in `gradle/wrapper/gradle-wrapper.properties`.

Dependencies are resolved from their upstream Maven repositories. AndroidX,
Kotlin and the BOOX SDK retain their respective upstream notices and terms;
the repository's MIT license does not relicense them. In particular,
`com.onyx.android.sdk:onyxsdk-pen:1.5.4` and its native libraries come from
BOOX's SDK repository. No vendor AAR or signing key is checked into this tree.

The preview uses a separate application ID and locally generated development
key. Public release signing and an upgrade from an existing installation are
separate delivery gates.
