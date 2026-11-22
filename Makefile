# Perso channel: run your own build daily, publish through PR -> CI -> merge.
# See "Perso channel" in README.md. NO_INSTALL=1 builds into releases/ only.
.PHONY: perso perso-status perso-rollback perso-hook
perso:
	@NO_INSTALL='$(NO_INSTALL)' scripts/perso.sh perso
perso-status:
	@scripts/perso.sh status
perso-rollback:
	@NO_INSTALL='$(NO_INSTALL)' scripts/perso.sh rollback
perso-hook:
	@scripts/perso-hook-install.sh
