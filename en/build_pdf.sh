#!/bin/bash
SCRIPT_DIR=$(cd $(dirname $0);pwd)

DOCLANG="en"
AUTHOR="CodeLibs"
RELEASE="1.0"

CONFDIR="${SCRIPT_DIR}/../conf"
BUILDDIR="${SCRIPT_DIR}/_build/pdf/${RELEASE}"

PROJECT="RecotemInstall"
TITLE="Recotem Installation Guide"
TYPE="install"
echo "Processing ${SCRIPT_DIR}/${RELEASE}/${TYPE}"
cd ${SCRIPT_DIR}/${RELEASE}/${TYPE}
make SPHINXOPTS="-c ${CONFDIR}" BUILDDIR="${BUILDDIR}/${TYPE}" SPHINX_LANG="${DOCLANG}" SPHINX_PROJECT="${PROJECT}" SPHINX_TITLE="${TITLE}" SPHINX_AUTHOR="${AUTHOR}" SPHINX_RELEASE="${RELEASE}" -f ${CONFDIR}/Makefile latexpdfja

PROJECT="RecotemUser"
TITLE="Recotem User Guide"
TYPE="user"
echo "Processing ${SCRIPT_DIR}/${RELEASE}/${TYPE}"
cd ${SCRIPT_DIR}/${RELEASE}/${TYPE}
make SPHINXOPTS="-c ${CONFDIR}" BUILDDIR="${BUILDDIR}/${TYPE}" SPHINX_LANG="${DOCLANG}" SPHINX_PROJECT="${PROJECT}" SPHINX_TITLE="${TITLE}" SPHINX_AUTHOR="${AUTHOR}" SPHINX_RELEASE="${RELEASE}" -f ${CONFDIR}/Makefile latexpdfja

PROJECT="RecotemApi"
TITLE="Recotem API Guide"
TYPE="api"
echo "Processing ${SCRIPT_DIR}/${RELEASE}/${TYPE}"
cd ${SCRIPT_DIR}/${RELEASE}/${TYPE}
make SPHINXOPTS="-c ${CONFDIR}" BUILDDIR="${BUILDDIR}/${TYPE}" SPHINX_LANG="${DOCLANG}" SPHINX_PROJECT="${PROJECT}" SPHINX_TITLE="${TITLE}" SPHINX_AUTHOR="${AUTHOR}" SPHINX_RELEASE="${RELEASE}" -f ${CONFDIR}/Makefile latexpdfja
