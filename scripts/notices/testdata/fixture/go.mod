module example.com/app

go 1.27

require (
	example.com/bare v1.0.0
	example.com/gpldep v1.0.0
	example.com/mitdep v1.2.0
	example.com/windep v0.3.0
)

replace (
	example.com/bare => ./mods/bare
	example.com/gpldep => ./mods/gpldep
	example.com/mitdep => ./mods/mitdep
	example.com/windep => ./mods/windep
)
