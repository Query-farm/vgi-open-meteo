"""Small presentation and input helpers; all analytical SQL stays in the notebook."""
from datetime import UTC, datetime
import re
import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns
from IPython.display import Markdown, display

PALETTE = ['#126D88', '#C47727']


def sql_text(value):
    return "'" + str(value).replace("'", "''") + "'"


def prepare(places, days, boundary, model):
    if not isinstance(places, list) or len(places) != 2 or any(not isinstance(p, str) or not p.strip() or len(p)>60 for p in places) or len(set(places)) != 2:
        raise ValueError('PLACES must contain two distinct nonempty place names (up to 60 characters each).')
    if type(days) is not int or not 1 <= days <= 5:
        raise ValueError('FORECAST_DAYS must be an integer from 1 to 5.')
    if boundary not in {'auto', 'GMT'}:
        raise ValueError("DAY_BOUNDARY must be 'auto' or 'GMT'.")
    if not isinstance(model, str) or not re.fullmatch(r'[A-Za-z0-9_]+', model):
        raise ValueError('MODEL must be one Open-Meteo selector, such as best_match.')


def prose(text):
    display(Markdown(text))


def number(value, places=1):
    return 'unavailable' if pd.isna(value) else f'{value:,.{places}f}'


def theme():
    sns.set_theme(style='whitegrid', context='notebook', palette=PALETTE,
        rc={'figure.dpi': 140, 'figure.facecolor': 'white', 'axes.facecolor': '#F8FAFC',
            'grid.color': '#DCE3E8', 'grid.linewidth': .6, 'axes.spines.top': False,
            'axes.spines.right': False, 'text.color': '#233547', 'axes.labelcolor': '#233547',
            'text.parse_math': False, 'font.family': 'DejaVu Sans'})
    pd.set_option('display.max_columns', 20)
    pd.set_option('display.width', 160)


def finish_chart(fig, title, subtitle, source):
    fig.suptitle(title, x=.09, ha='left', fontsize=17, fontweight='bold', y=.985)
    fig.text(.09, 1 - .43 / fig.get_figheight(), subtitle, ha='left', fontsize=10, color='#526779')
    fig.text(.09, .025, source, ha='left', fontsize=8, color='#526779')
    fig.subplots_adjust(left=.09, right=.97, top=1 - .95 / fig.get_figheight(), bottom=max(.16, 1.0 / fig.get_figheight()), hspace=.38, wspace=.20)
    plt.show()
