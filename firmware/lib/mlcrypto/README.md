# mlcrypto

Subset of Rhys Weatherley's Arduino Crypto library (https://github.com/rweather/arduinolibs, MIT license, see file headers): BLAKE2s, Ed25519 and their dependencies.

It is vendored, not a `lib_deps` entry, because the library's `Hash.h` shadows the ESP8266 core `Hash.h` that the WebSockets library needs. Here it is renamed to `CryptoHash.h`.
