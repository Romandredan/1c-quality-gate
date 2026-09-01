# Отчёт прогона quality-gate

Находок нет.

## quality evidence

[qg scope: volume=C1, files=1, loc=+12/-2, archetypes=[none], complexity=[none], driver=volume, resolved=code:L1|arch:skip|xml:n/a|hygiene:full, config=default]
[qg sentinel: target=v8std, id=std454, status=found]
[qg applied: layer=hygiene, scope=file-encoding, ids=[qg:HYG-BOM], verdict=clean]
[qg applied: layer=code, scope=naming-std454, ids=[std454], verdict=clean]
[qg skipped: layer=code, scope=platform-api, planned=[pc:*], reason=no_platform_install]
[qg skipped: layer=arch, reason=volume_below_threshold]
[qg skipped: layer=xml, reason=not_applicable]
[qg not_verified: dimension=compilation, reason=no_platform]
