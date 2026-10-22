# Ten rules for talking to real printers (Windows)

Hard-won conclusions from driving thermal label printers, 58/80 mm
receipt printers and a dot-matrix delivery printer over the Windows
print spooler on real point-of-sale hardware. Each rule cost at least
one failed debugging round; all are portable knowledge, none are
specific to any product.

1. **Never hand-craft Win32 struct offsets, and never write them from
   memory.** `PRINTER_INFO_2` differs between x86 and x64 (pointer
   packing moves every field after the first pointer). Use the platform
   definitions, or marshal with explicit layout. A struct that "works
   on my machine" is an architecture you haven't tested.
2. **A first Win32 sizing call failing is the protocol, not an error.**
   Calls like `GetPrinter` are two-stage: call once with a tiny buffer
   to learn the required size (this call *fails* by design), allocate,
   call again. Treating the first failure as fatal — or worse, using
   its return value as a verdict — breaks every correct driver call.
3. **`Process.Start` does not expand `%ENV%` literals.** Launching
   `rundll32` (or anything) directly goes through CreateProcess, not a
   shell: `%windir%` stays literal and the target is never found. Expand
   via `Environment.GetFolderPath`/`ExpandEnvironmentVariables` or go
   through `cmd /c` deliberately.
4. **`DllImport` CharSet must match the struct's string field type.**
   `CharSet.Ansi` P/Invoke with `LPWStr` fields over-reads memory and
   corrupts adjacent fields — often silently. Audit both sides of every
   signature.
5. **On UI threads, `ConfigureAwait(false)` all the way down the
   transport layer.** A `.Wait()` higher up plus a missing
   `ConfigureAwait(false)` lower down is a textbook deadlock: the
   continuation queues to a thread that is blocked waiting for it.
6. **Bind WPF `Visibility` to booleans, never to object references.**
   Reference-typed values fall through to hidden/unexpected converters
   and the element silently vanishes.
7. **A "Generic / Text Only" spooler queue with RAW datatype is the
   universal driver-free path.** Create it programmatically against the
   USB port (needs elevation; degrade honestly when not elevated) and
   write protocol bytes straight through — this bypasses vendor driver
   quirks entirely and is how most USB label printers are best driven.
8. **Expect USB discovery via the registry, not the driver stack.**
   Enumerating `USBPRINT` entries finds printers whose vendor driver
   failed to install — and a vendor installer popping a failure dialog
   does not mean the device is unusable over the Text-Only queue.
9. **Poisoned state must block `Dispose` paths too.** When you mark a
   handle/session as poisoned, every exit path — including disposal and
   timeouts — must respect it, or a background writer resurrects a dead
   channel.
10. **Fire-and-forget continuations on UI-captured state need explicit
    discards.** An unobserved continuation that captures a view-model
    after the user closed the window keeps the whole visual tree alive
    and can crash later; discard deliberately (`_ =`) and capture
    nothing UI-bound.

## Contributing device reports

See the report template in this directory. Reports are accepted with a
printed nonce challenge (proof-of-hardware), not just a screenshot.
