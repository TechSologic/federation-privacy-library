# Documentation

Start with the [architecture overview](using-library/architecture.md) for the
components, public interfaces, integration choices and operation flows.
Then choose the stream that matches your work:

| Audience                                   | Start here                                             | Covers                                                                         |
| ------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Building an application with the library   | [Using the library](using-library/README.md)           | Public API, providers, Tor integration, lifecycle and privacy responsibilities |
| Changing or maintaining the library itself | [Developing the library](https://github.com/TechSologic/federation-privacy-library/blob/main/docs/developing-library/README.md) | Development, architecture, security, testing, contribution and releases        |

The API is experimental. These guides describe the implemented library and its
provider contracts; use the declarations shipped with your installed artifact.

Keep application contracts and integration guidance in `using-library/`.
Keep implementation design and maintenance procedures in `developing-library/`.
Link to shared contracts instead of duplicating them. Keep behavior, examples
and limitations consistent with the public declarations.
