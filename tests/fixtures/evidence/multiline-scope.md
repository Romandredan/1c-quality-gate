# Длинная запись scope перенесена по строкам

## quality evidence

[qg scope: volume=C2, files=3, loc=+87/-12, archetypes=[query,transaction],
           complexity=[nesting:4], driver=archetype:transaction,
           resolved=code:L2|arch:skip|xml:n/a|hygiene:full,
           config=custom:volume+sentinel]
[qg sentinel: target=v8std, id=std454, status=found]
[qg applied: layer=code, scope=query-in-loop, ids=[std436], verdict=violation:std436]
[qg skipped: layer=code, scope=ai-antipatterns, reason=reader_unavailable]
[qg skipped: layer=code, scope=platform-antipatterns, reason=reader_unavailable]
[qg not_verified: dimension=compilation, reason=no_platform]
[qg not_verified: dimension=query-execution, reason=no_platform]
