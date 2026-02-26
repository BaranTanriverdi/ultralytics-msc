import os
import sys
import pandas as pd
import numpy as np

def process_data(data_path):
    """
    Process some data using pandas.
    """
    df = pd.read_csv(data_path)
    return df.describe()

if __name__ == "__main__":
    print("Processing data...")
    process_data("data.csv")
