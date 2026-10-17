# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT

.PHONY: install
install:
	install -m 0755 bin/* /usr/local/bin/
