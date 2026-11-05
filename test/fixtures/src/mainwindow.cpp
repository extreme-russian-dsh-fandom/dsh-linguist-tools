#include "mainwindow.h"

void MainWindow::setupUi()
{
    setWindowTitle(tr("Welcome to Example Studio"));
    fileMenu->setTitle(tr("&File"));
    statusBar()->showMessage(tr("%1 of %2 files processed"));
    countLabel->setText(tr("%n point(s)", nullptr, count));
    warningLabel->setText(tr("<b>Note:</b> unsaved changes will be lost."));
    snapshotButton->setText(tr("Snapshot"));
    exportButton->setText(tr("Export report"));
    toleranceLabel->setText(tr("Tolerance"));
    licenceAction->setText(tr("Licence"));
    probeButton->setText(tr("Probe the connection"));
}
