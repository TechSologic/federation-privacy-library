# Source Attribution

Copyright (c) 2026 TechSologic Inc. and contributors.

Code author: Michael Stapleton <mike@techsologic.com>, for TechSologic Inc.

This library is licensed under AGPL-3.0-only; see LICENSE.
The transport-independent DHT algorithms in src/dht are adapted from the
UnoLock federated node, revision 6a42004519c9d72d3e1d68793e52ed0c27efe43b,
under the same license. The maintenance coordinator is extracted from node
revision ede22e6e17ce5dd2962726edfb3d0f3580407232. The incremental lookup record,
routing identity, and RPC client modules in src/protocol are extracted from that
same node revision. Address and protocol codecs follow that implementation.
The incremental outgoing delivery coordinator, destination resolver, queue policy helpers, and worker
in src/delivery are extracted from node revision
a5a2016f5ece1deb539a8546b72fefed9bb76416 under the same license.
No content encryption or application sharing workflow is imported.

The runtime uses `@noble/post-quantum` for ML-DSA-65 route authorization. That
package is distributed under the MIT License; its copyright and license text
remain in the installed package.

The public TypeScript declarations depend on `@types/node` and its
`undici-types` dependency. Both use the MIT License and retain their notices
in the installed packages.

Development dependencies retain their respective license notices in their
installed packages. They are not bundled into the library runtime.
